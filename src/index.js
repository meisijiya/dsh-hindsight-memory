/**
 * dsh-hindsight-memory — DSH ⇄ omp 记忆行为对齐插件。
 *
 * 定位：**中间层**。
 *   - 下游：Hindsight 记忆服务（同一个 bank，REST 或官方 per-bank MCP 两种传输）；
 *   - 上游：DSH 的模型，只看见 4 个语义化工具；
 *   - 职责：把"模型说的话"翻译成"omp 也会做的同一件事"——
 *     同一 bank、同一标签、同一分层、同一过滤语义。
 *
 * 关键约束（都来自 DSH 与 Hindsight 的实测，不是猜的）：
 *   1. 工具**只在 apply 时注册一次**。每回合注册/注销会改写请求头里的工具 schema，
 *      没有 toolUpdate 能力的适配器会因此重开请求序列 ⇒ 缓存作废。
 *   2. 系统提示词段是**编译期常量**。任何随回合变化的内容都不能写进 section。
 *   3. 变化的内容走 `agent/pre-step` 注入的**用户消息**（落在缓存边界之后）。
 *   4. 每个 agent 一个 client，按 agent id 缓存；agent 销毁时清理。
 *   5. 所有失败路径**不得让整轮请求失败**：记忆是增强，不是依赖。
 */

import { randomUUID } from "node:crypto";
import { normalizeConfig } from "./config.js";
import { LiveConfig } from "./schema.js";
import { resolveProjectLabel } from "./label.js";
import { HindsightMemoryClient } from "./client.js";
import { SCOPE, TIER, computeBankScope } from "./parity.js";
import { normalizeScope, sanitizeMemoryText, sanitizeTags } from "./sanitize.js";
import { findDuplicateGroups, planPrune, summarizeGroups, filterByScope, describeLayers } from "./hygiene.js";
import {
	mentalModelIds,
	mentalModelSpecs,
	normalizeMentalModels,
	planEnsure,
} from "./mental-models.js";
import {
	MEMORY_PROTOCOL,
	buildPromptSection,
	extractUserPrompt,
	renderRecallMessage,
	renderMentalModelMessage,
} from "./prompt.js";

export const name = "hindsight-memory";

/** 依赖的服务：工具注册、系统提示词段。
 *  注意：**不**把 workingDirectory 写进 inject——服务缺失时会让整个 profile 装载失败，
 *  而记忆只是增强。工作目录改为「能取到就用，取不到就回落 session.cwd」的柔性策略。 */
export const inject = ["tools", "systemPrompt"];

/** 导出的是 **volatile 变体**：宿主的「插件 → 配置」表单只显示 volatile 字段，
 *  且只有运行中的插件行才会被投影成可编辑配置项（settings namespace）。
 *  没有这层标记，插件页只会写「settings namespace 未就绪」——不是 bug，是宿主契约。 */
export { LiveConfig as Config };

/**
 * 解开宿主的 volatile 包装。
 *
 * 宿主把可在线改的字段包成 `{ get(), write }` 引用对象（cosmokit 的 volatile），
 * 改配置时是**改引用里的值**而不是替换对象 ⇒ 插件必须每次读当前值，
 * 直接当普通值用会拿到包装对象本身（`[object Object]`）。
 * @param {unknown} value 待解包的值。
 */
function unwrapVolatile(value) {
	if (
		typeof value === "object" &&
		value !== null &&
		"write" in value &&
		typeof value.get === "function"
	) {
		return value.get();
	}
	return value;
}

/**
 * 递归解开配置对象里的 volatile 包装。
 * @param {Record<string, unknown>} value 原始配置。
 */
function unwrapConfig(value) {
	const out = {};
	for (const [key, child] of Object.entries(value ?? {})) {
		const raw = unwrapVolatile(child);
		out[key] =
			raw && typeof raw === "object" && !Array.isArray(raw) ? unwrapConfig(raw) : raw;
	}
	return out;
}

const JSON_OBJECT_OUTPUT = { type: "object", additionalProperties: true };

/** 记忆卫生可作用的层。 */
const HYGIENE_SCOPES = new Set(["all", "project", "global", "other"]);

/**
 * 归一化记忆卫生的作用层。
 * @param {unknown} value 原始值。
 * @param {string} fallback 配置里的默认值。
 * @returns {"all"|"project"|"global"|"other"}
 */
function normalizeHygieneScope(value, fallback = "all") {
	if (typeof value === "string" && HYGIENE_SCOPES.has(value)) return value;
	return HYGIENE_SCOPES.has(fallback) ? fallback : "all";
}

/** 工具错误统一形状。 */
function toolError(message) {
	return {
		content: [{ type: "text", text: JSON.stringify({ error: { message } }) }],
		isError: true,
	};
}

function toolJson(value) {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/**
 * 按层统计事实数量。
 * @param {Array} facts 事实列表。
 * @param {string} projectLabel 本项目标签（小写）。
 */
function countLayers(facts, projectLabel) {
	const projectTag = `project:${projectLabel}`;
	let global = 0;
	let project = 0;
	let other = 0;
	for (const fact of facts ?? []) {
		const tags = Array.isArray(fact?.tags) ? fact.tags : [];
		if (tags.length === 0) global += 1;
		else if (tags.includes(projectTag)) project += 1;
		else other += 1;
	}
	return { global, project, other, total: (facts ?? []).length };
}

/** 分层统计（失败不抛——状态查询不该因为多一次调用就失败）。 */
async function layerCounts(channel, signal) {
	try {
		const raw = await channel.client.listFacts({ limit: 500, signal });
		const facts = Array.isArray(raw) ? raw : (raw?.items ?? raw?.memories ?? []);
		const active = facts.filter((f) => (f?.state ?? "valid") === "valid");
		return countLayers(active, channel.label);
	} catch {
		return null;
	}
}

/**
 * 分层体检（每层条数 + 事实类型分布 + 最近更新时间）。
 * 失败不抛——状态查询不该因为多一次调用就失败。
 * @param {object} channel 记忆通道。
 * @param {AbortSignal} [signal]
 */
async function layerDetails(channel, signal) {
	try {
		const raw = await channel.client.listFacts({ limit: 500, signal });
		const facts = Array.isArray(raw) ? raw : (raw?.items ?? raw?.memories ?? []);
		const active = facts.filter((f) => (f?.state ?? "valid") === "valid");
		return describeLayers(active, channel.label);
	} catch {
		return null;
	}
}

/**
 * 运维观测：服务端任务队列摘要。
 * 报告 §6.10：**失败任务不会自动重试**，不观测就会出现「写进去了但查不到」的静默故障。
 * @param {object} channel 记忆通道。
 * @param {number} limit 取多少条。
 * @param {AbortSignal} [signal]
 */
async function operationSummary(channel, limit, signal) {
	try {
		const raw = await channel.client.listOperations({ limit, signal });
		const operations = Array.isArray(raw)
			? raw
			: (raw?.operations ?? raw?.items ?? []);
		const byStatus = {};
		const byTask = {};
		const recent = [];
		for (const op of operations) {
			const status = String(op?.status ?? "unknown");
			byStatus[status] = (byStatus[status] ?? 0) + 1;
			const task = String(op?.task_type ?? op?.operation_type ?? "unknown");
			byTask[task] = (byTask[task] ?? 0) + 1;
			recent.push({
				id: op?.operation_id ?? op?.id,
				status,
				taskType: task,
				error: op?.error_message ?? null,
				retryCount: op?.retry_count ?? null,
				createdAt: op?.created_at ?? null,
			});
		}
		return { total: raw?.total ?? operations.length, byStatus, byTask, recent };
	} catch (error) {
		return { error: error?.message ?? String(error) };
	}
}

/**
 * 候选 consolidation 策略。
 * 项目层用通配 scope 命中；**全局层（无标签 scope）无法被任何规则命中**——
 * 服务端的匹配语义是「scope 含全部规则标签」，空标签 scope 谁都匹配不上，
 * 所以全局层只能靠 bank 级默认值兜住。
 */
function candidateStrategies(config) {
	return [
		{
			scopes: [{ tags: ["project:*"], tags_match: "all" }],
			observations_mission: config.hygieneProjectMission,
			max_observations_per_scope: config.hygieneProjectMaxObservations,
		},
	];
}

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文。
 * @param {object} rawConfig 配置。
 */
export async function apply(ctx, rawConfig = {}) {
	const config = normalizeConfig(unwrapConfig(rawConfig));
	const log = (message) => {
		try {
			ctx.logger?.warn?.(`hindsight-memory: ${message}`);
		} catch {
			/* logger 不可用也不能影响插件 */
		}
	};

	if (!config.enabled) {
		log("disabled by config; nothing registered");
		return;
	}

	// ── 1) 常驻系统提示词段（常量文本，字节稳定）────────────────────────
	if (config.inject) {
		const dispose = ctx.systemPrompt.section({
			name: "hindsight:memory",
			order: config.sectionOrder,
			interpolate: false,
			text: buildPromptSection(config),
		});
		ctx.effect(() => dispose);
	}

	// ── 2) 每个 agent 的记忆通道 ────────────────────────────────────────
	/** @type {Map<string, {dir: string, label: string, client: HindsightMemoryClient, primed: boolean}>} */
	const channels = new Map();

	async function channelFor(agent) {
		if (!agent) return null;
		const cached = channels.get(agent.id);
		if (cached) return cached;

		let dir = "";
		try {
			// DSH 的会话工作目录服务（可选服务，取不到就回落）。
			dir = ctx.workingDirectory?.get?.(agent.session) ?? "";
		} catch {
			dir = "";
		}
		if (!dir) dir = agent?.session?.header?.cwd ?? "";
		if (!dir) dir = process.cwd();
		const label = await resolveProjectLabel(dir, config.projectLabelOverride);
		const client = new HindsightMemoryClient({ config, label, log });
		const channel = { dir, label, client, primed: false, turnCount: 0 };
		channels.set(agent.id, channel);
		return channel;
	}

	ctx.on("agent/disposed", (payload) => {
		const id = payload?.agent?.id;
		if (id) channels.delete(id);
	});
	ctx.effect(() => {
		channels.clear();
	});

	// ── 2.5) 配置在线更新（宿主「插件 → 配置」表单保存后触发）──────────────
	// 宿主把 volatile 字段的新值**写进引用对象**，所以这里重新读一遍原始配置即可。
	// bank / apiUrl 变了 ⇒ 旧的 MCP 连接与 bank scope 都要作废重建。
	ctx.on("loader/volatile-update", (paths) => {
		try {
			const next = normalizeConfig(unwrapConfig(rawConfig));
			Object.assign(config, next);
			for (const channel of channels.values()) {
				channel.client.config = config;
				channel.client.scope = computeBankScope(config, channel.label);
				channel.client.mcp = null;
				channel.primed = false;
			}
			log(`config updated: ${Array.isArray(paths) ? paths.join(", ") : "?"}`);
		} catch (error) {
			log(`config update failed: ${error?.message ?? error}`);
		}
	});

	// ── 3) 工具（一次注册，模型可见面恒定）──────────────────────────────
	const requireChannel = async (exec) => {
		const agent = exec?.agent;
		if (!agent) throw new Error("记忆工具需要活动的 DSH agent");
		const channel = await channelFor(agent);
		if (!channel) throw new Error("无法解析当前会话的工作目录");
		return channel;
	};

	/**
	 * 取 mental model（精神模型）正文，渲染成注入块。
	 *
	 * 与 omp 对齐：omp 启动时保证 3 个 mental model 存在并把正文注入会话提示。
	 * DSH 侧同样在**会话首轮**做一次（ensure + 取正文），
	 * 之后不再重取 —— 正文变了也不重取，避免提示词前缀在会话中途变化。
	 *
	 * @param {object} channel 记忆通道。
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<string>} 注入文本（空串 = 没有可注入的模型）。
	 */
	async function mentalModelBlock(channel, signal) {
		if (!channel.mentalModelsEnsured) {
			channel.mentalModelsEnsured = true;
			try {
				const scope = computeBankScope(config, channel.label);
				const specs = mentalModelSpecs(config, channel.label, scope.retainTags ?? []);
				const raw = await channel.client.listMentalModels({
					detail: "metadata",
					limit: 200,
					signal,
				});
				const existing = raw?.models ?? raw?.items ?? raw ?? [];
				const plan = planEnsure(existing, specs);
				for (const spec of plan.create) {
					try {
						await channel.client.createMentalModel(spec, { signal });
					} catch (error) {
						log(`mental model 创建失败（忽略）：${spec.id} ${error?.message ?? error}`);
					}
				}
				for (const item of plan.patch) {
					try {
						await channel.client.patchMentalModel(item.id, { tags: item.tags }, { signal });
					} catch (error) {
						log(`mental model 标签修正失败（忽略）：${item.id} ${error?.message ?? error}`);
					}
				}
			} catch (error) {
				log(`mental model ensure 失败（忽略）：${error?.message ?? error}`);
			}
		}
		try {
			const raw = await channel.client.listMentalModels({
				detail: "content",
				limit: 200,
				signal,
			});
			const models = normalizeMentalModels(raw?.models ?? raw?.items ?? raw);
			const wanted = Object.values(mentalModelIds(config, channel.label));
			const mine = models.filter((model) => wanted.includes(model.id));
			return renderMentalModelMessage(mine, { bankId: channel.client.bankId });
		} catch (error) {
			log(`mental model 取正文失败（忽略）：${error?.message ?? error}`);
			return "";
		}
	}

	const tools = [
		{
			name: "memory_recall",
			description:
				"搜索长期记忆（与 omp 共享同一个 Hindsight 记忆库）。scope=project 返回本项目事实 + 跨项目全局事实；scope=project_only 只返回本项目事实；scope=global 只返回全局事实。",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "检索用的自然语言查询。" },
					scope: {
						type: "string",
						enum: [SCOPE.PROJECT, SCOPE.PROJECT_ONLY, SCOPE.GLOBAL],
						description: "召回范围，默认 project（本项目 + 全局）。",
					},
					budget: {
						type: "string",
						enum: ["low", "mid", "high"],
						description: "召回预算，默认 mid。",
					},
				},
				required: ["query"],
			},
			output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => toolJson(value).content },
			execute: async (args, exec) => {
				const query = String(args?.query ?? "").trim();
				if (!query) return toolError("memory_recall 需要非空 query");
				try {
					const channel = await requireChannel(exec);
					const scope = normalizeScope(args?.scope, SCOPE.PROJECT);
					const result = await channel.client.recall({
						query,
						scope,
						budget: args?.budget,
						signal: exec?.signal,
					});
					return toolJson({
						bankId: result.bankId,
						projectLabel: channel.label,
						scope,
						count: result.facts.length,
						facts: result.facts,
					});
				} catch (error) {
					log(`memory_recall failed: ${error?.message ?? error}`);
					return toolError(`召回失败：${error?.message ?? error}`);
				}
			},
			presentCall: (args) => ({
				card: "generic",
				title: "召回长期记忆",
				kind: "search",
				description: String(args?.query ?? "").slice(0, 120),
			}),
		},
		{
			name: "memory_retain",
			description:
				"写入一条耐久记忆。tier=project（默认）只有本项目能看到；tier=global 所有项目都能看到。标签与 bank 路由由插件自动处理，不要自己写标签。写入是异步的，可能几十秒后才能被检索到。",
			parameters: {
				type: "object",
				properties: {
					content: { type: "string", description: "要记住的事实，一条一件。" },
					tier: {
						type: "string",
						enum: [TIER.PROJECT, TIER.GLOBAL],
						description: "记忆分层，默认 project。",
					},
					context: {
						type: "string",
						description: "可选的上下文说明（例如来源、适用条件）。",
					},
				},
				required: ["content"],
			},
			output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => toolJson(value).content },
			execute: async (args, exec) => {
				const content = sanitizeMemoryText(String(args?.content ?? ""));
				if (!content) return toolError("memory_retain 需要非空 content");
				try {
					const channel = await requireChannel(exec);
					const tier = String(args?.tier ?? TIER.PROJECT) === TIER.GLOBAL ? TIER.GLOBAL : TIER.PROJECT;
					const context = sanitizeMemoryText(String(args?.context ?? ""));
					const result = await channel.client.retain({
						content,
						tier,
						context: context || undefined,
						sessionId: exec?.agent?.id,
						signal: exec?.signal,
					});
					return toolJson({
						accepted: true,
						tier: result.tier,
						tags: result.tags,
						bankId: channel.client.bankId,
						projectLabel: channel.label,
					});
				} catch (error) {
					log(`memory_retain failed: ${error?.message ?? error}`);
					return toolError(`写入失败：${error?.message ?? error}`);
				}
			},
			presentCall: (args) => ({
				card: "generic",
				title: "写入长期记忆",
				kind: "create",
				description: String(args?.content ?? "").slice(0, 120),
			}),
		},
		{
			name: "memory_reflect",
			description:
				"让记忆服务基于已存事实综合回答一个问题（而不是返回原始条目）。scope 语义与 memory_recall 相同。",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "要综合回答的问题。" },
					scope: {
						type: "string",
						enum: [SCOPE.PROJECT, SCOPE.PROJECT_ONLY, SCOPE.GLOBAL],
						description: "综合范围，默认 project。",
					},
					budget: {
						type: "string",
						enum: ["low", "mid", "high"],
						description: "预算，默认 mid。",
					},
				},
				required: ["query"],
			},
			output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => toolJson(value).content },
			execute: async (args, exec) => {
				const query = String(args?.query ?? "").trim();
				if (!query) return toolError("memory_reflect 需要非空 query");
				try {
					const channel = await requireChannel(exec);
					const scope = normalizeScope(args?.scope, SCOPE.PROJECT);
					const result = await channel.client.reflect({
						query,
						scope,
						budget: args?.budget,
						signal: exec?.signal,
					});
					return toolJson({ bankId: channel.client.bankId, scope, result });
				} catch (error) {
					log(`memory_reflect failed: ${error?.message ?? error}`);
					return toolError(`综合失败：${error?.message ?? error}`);
				}
			},
		},
		{
			name: "memory_status",
			description:
				"检查记忆服务连通性、当前 bank、项目标签、各层事实数量与任务队列健康度。用于排查「记忆读不到 / 写不进去」。",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => toolJson(value).content },
			execute: async (_args, exec) => {
				try {
					const channel = await requireChannel(exec);
					const status = await channel.client.status({ signal: exec?.signal });
					const bank = await channel.client.bankOverview({ signal: exec?.signal });
					const layers = await layerCounts(channel, exec?.signal);
					const layerDetail = await layerDetails(channel, exec?.signal);
					const operations = await operationSummary(channel, config.operationsLimit, exec?.signal);
					return toolJson({
						...status,
						bank,
						projectLabel: channel.label,
						workingDirectory: channel.dir,
						scoping: config.scoping,
						writeEnabled: config.writeEnabled,
						layers,
						layerDetail,
						operations,
					});
				} catch (error) {
					return toolError(`状态查询失败：${error?.message ?? error}`);
				}
			},
		},
		{
			name: "memory_hygiene",
			description:
				"整理共享记忆库（DSH 与 omp 同一个 bank，改一处两端同时见效）。scope 选层：project=本项目层，global=跨项目全局层（无 tag，所有项目可见），other=其它项目层，all=整库。action=preview 只读地列出近重复事实与各层分布；action=layers 只读地给出每层的条数、事实类型分布与最近更新时间；action=prune 作废近重复事实（每组保留最新一条，服务端可逆：state 可改回 valid）；action=consolidate 触发服务端合并 observation；action=scopes 查看各层 observation 数量；action=strategies-preview 预览分层口径的命中情况。",
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: ["preview", "layers", "prune", "consolidate", "scopes", "strategies-preview"],
						description: "要执行的整理动作，默认 preview（只读）。layers 只读地给出每层的条数、类型分布与最近更新时间。",
					},
					scope: {
						type: "string",
						enum: ["all", "project", "global", "other"],
						description: "作用范围：project=本项目层，global=跨项目全局层（无 tag），other=其它项目层，all=整库。默认取插件配置。",
					},
					dryRun: {
						type: "boolean",
						description: "prune 时是否只报告不落手，默认 true。",
					},
					threshold: {
						type: "number",
						description: "近重复相似度阈值（0.5-1），默认取插件配置。",
					},
					limit: {
						type: "number",
						description: "扫描的事实条数上限，默认取插件配置。",
					},
				},
				required: [],
			},
			output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => toolJson(value).content },
			execute: async (args, exec) => {
				try {
					const channel = await requireChannel(exec);
					const action = String(args?.action ?? "preview");
					const client = channel.client;

					if (action === "consolidate") {
						const result = await client.consolidate({ signal: exec?.signal });
						return toolJson({ ok: true, action, bankId: client.bankId, result });
					}
					if (action === "scopes") {
						const scopes = await client.observationScopes({ signal: exec?.signal });
						return toolJson({ ok: true, action, bankId: client.bankId, scopes });
					}
					if (action === "strategies-preview") {
						const preview = await client.previewStrategies(candidateStrategies(config), {
							signal: exec?.signal,
						});
						return toolJson({ ok: true, action, bankId: client.bankId, preview });
					}

					const threshold = Number.isFinite(Number(args?.threshold))
						? Math.min(1, Math.max(0.5, Number(args.threshold)))
						: config.hygieneThreshold;
					const limit = Number.isFinite(Number(args?.limit))
						? Math.min(2_000, Math.max(20, Math.trunc(Number(args.limit))))
						: config.hygieneMaxFacts;

					const raw = await client.listFacts({ limit, signal: exec?.signal });
					const facts = Array.isArray(raw) ? raw : (raw?.items ?? raw?.memories ?? []);
					const active = facts.filter((f) => (f?.state ?? "valid") === "valid");
					const scope = normalizeHygieneScope(args?.scope, config.hygieneScope);
					const scoped = filterByScope(active, scope, channel.label);
					const details = describeLayers(active, channel.label);

					if (action === "layers") {
						return toolJson({
							ok: true,
							action: "layers",
							bankId: client.bankId,
							projectLabel: channel.label,
							scanned: active.length,
							scope,
							layers: details,
							note:
								"全局层=无 tag，所有项目可见且服务端不会自动淘汰；项目层=带 project 标签，有 observation 上限兜底。",
						});
					}

					const { groups, crossScope, scanned } = findDuplicateGroups(scoped, {
						threshold,
						maxFacts: limit,
					});
					const plan = planPrune(groups);
					const layers = countLayers(scoped, channel.label);

					if (action === "prune") {
						const dryRun = args?.dryRun !== false;
						const results = [];
						for (const fact of plan.invalidate) {
							if (dryRun) {
								results.push({ id: fact?.id, state: "would-invalidate" });
								continue;
							}
							try {
								await client.setFactState(fact?.id, "invalidated", {
									signal: exec?.signal,
								});
								results.push({ id: fact?.id, state: "invalidated" });
							} catch (error) {
								results.push({ id: fact?.id, state: "failed", error: error?.message });
							}
						}
						return toolJson({
							ok: true,
							action,
							dryRun,
							bankId: client.bankId,
							scanned,
							threshold,
							layers,
							duplicateGroups: groups.length,
							duplicateFacts: plan.invalidate.length,
							crossScopeSameText: crossScope.length,
							results,
						});
					}

					return toolJson({
						ok: true,
						action: "preview",
						bankId: client.bankId,
						scanned,
						threshold,
						layers,
						duplicateGroups: summarizeGroups(groups),
						duplicateGroupCount: groups.length,
						duplicateFactCount: plan.invalidate.length,
						crossScopeSameText: crossScope.length,
					});
				} catch (error) {
					log(`memory_hygiene failed: ${error?.message ?? error}`);
					return toolError(`整理失败：${error?.message ?? error}`);
				}
			},
			presentCall: (args) => ({
				card: "generic",
				title: "整理长期记忆",
				kind: "search",
				description: String(args?.action ?? "preview"),
			}),
		},
		{
			name: "memory_mental_models",
			description:
				"维护 mental model（精神模型）层：服务端从事实层归纳出来的长期画像，可注入会话。action=ensure 幂等确保「用户偏好 + 本项目约定 + 本项目决策」三个模型存在（缺的创建、标签不符的修正）；action=list 列模型元数据与健康状态；action=content 取正文；action=refresh 触发增量刷新（异步）；action=patch 改内容或标签。",
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: ["ensure", "list", "content", "refresh", "patch"],
						description: "要执行的动作，默认 list。",
					},
					id: {
						type: "string",
						description: "目标模型 id（refresh / patch 必填；content 留空则取全部）。",
					},
					content: {
						type: "string",
						description: "patch 时的新正文。",
					},
					tags: {
						type: "array",
						items: { type: "string" },
						description: "patch 时的新标签。",
					},
				},
				required: [],
			},
			output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => toolJson(value).content },
			execute: async (args, exec) => {
				try {
					const channel = await requireChannel(exec);
					const client = channel.client;
					const action = String(args?.action ?? "list");
					const scope = computeBankScope(config, channel.label);
					const projectTags = scope.retainTags ?? [];
					const ids = mentalModelIds(config, channel.label);

					if (action === "list" || action === "content") {
						const detail = action === "content" ? "content" : "metadata";
						const raw = await client.listMentalModels({
							detail,
							limit: 200,
							signal: exec?.signal,
						});
						const models = normalizeMentalModels(raw?.models ?? raw?.items ?? raw);
						const filtered = args?.id
							? models.filter((model) => model.id === String(args.id))
							: models;
						return toolJson({
							ok: true,
							action,
							bankId: client.bankId,
							projectLabel: channel.label,
							expectedIds: ids,
							count: filtered.length,
							models: filtered,
						});
					}

					if (action === "ensure") {
						const specs = mentalModelSpecs(config, channel.label, projectTags);
						const raw = await client.listMentalModels({
							detail: "metadata",
							limit: 200,
							signal: exec?.signal,
						});
						const existing = raw?.models ?? raw?.items ?? raw ?? [];
						const plan = planEnsure(existing, specs);
						const results = [];
						for (const spec of plan.create) {
							try {
								const created = await client.createMentalModel(spec, { signal: exec?.signal });
								results.push({ id: spec.id, action: "created", operationId: created?.operation_id });
							} catch (error) {
								// 409 = 别的进程刚建过（POST 是仅创建语义），不是失败。
								const conflict = /409/.test(String(error?.message ?? ""));
								results.push({
									id: spec.id,
									action: conflict ? "exists" : "failed",
									error: error?.message,
								});
							}
						}
						for (const item of plan.patch) {
							try {
								await client.patchMentalModel(item.id, { tags: item.tags }, { signal: exec?.signal });
								results.push({ id: item.id, action: "tags-patched", tags: item.tags });
							} catch (error) {
								results.push({ id: item.id, action: "failed", error: error?.message });
							}
						}
						for (const item of plan.keep) {
							results.push({ id: item.id, action: "kept", tags: item.tags });
						}
						return toolJson({
							ok: true,
							action,
							bankId: client.bankId,
							projectLabel: channel.label,
							created: plan.create.length,
							patched: plan.patch.length,
							kept: plan.keep.length,
							results,
						});
					}

					if (action === "refresh") {
						const target = String(args?.id ?? "").trim();
						const list = target ? [target] : Object.values(ids);
						const results = [];
						for (const id of list) {
							try {
								const refreshed = await client.refreshMentalModel(id, { signal: exec?.signal });
								results.push({ id, action: "queued", operationId: refreshed?.operation_id });
							} catch (error) {
								results.push({ id, action: "failed", error: error?.message });
							}
						}
						return toolJson({ ok: true, action, bankId: client.bankId, results });
					}

					if (action === "patch") {
						const id = String(args?.id ?? "").trim();
						if (!id) return toolError("memory_mental_models patch 需要 id");
						const patch = {};
						if (typeof args?.content === "string" && args.content.trim()) {
							patch.content = args.content.trim();
						}
						if (Array.isArray(args?.tags)) {
							patch.tags = args.tags.map((tag) => String(tag));
						}
						if (Object.keys(patch).length === 0) {
							return toolError("memory_mental_models patch 需要 content 或 tags");
						}
						const updated = await client.patchMentalModel(id, patch, { signal: exec?.signal });
						return toolJson({ ok: true, action, bankId: client.bankId, id, patch, result: updated });
					}

					return toolError(`memory_mental_models 不支持的动作：${action}`);
				} catch (error) {
					log(`memory_mental_models failed: ${error?.message ?? error}`);
					return toolError(`精神模型操作失败：${error?.message ?? error}`);
				}
			},
		},
		{
			name: "memory_operations",
			description:
				"查看并处理服务端任务队列。失败与僵尸任务**不会自动重试**（服务端 retry_count=0、next_retry_at=null），所以写入「没查到」时先看这里。action=list 列出最近的 operation 及其状态；action=retry 重试指定 operation；action=delete 删除卡住的 operation（真删，会清掉僵尸 pending 行）。",
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: ["list", "retry", "delete"],
						description: "要执行的动作，默认 list。",
					},
					operationId: {
						type: "string",
						description: "retry / delete 的目标 operation id。",
					},
					limit: {
						type: "number",
						description: "list 时取多少条，默认取插件配置。",
					},
				},
				required: [],
			},
			output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => toolJson(value).content },
			execute: async (args, exec) => {
				try {
					const channel = await requireChannel(exec);
					const client = channel.client;
					const action = String(args?.action ?? "list");
					if (action === "list") {
						const limit = Number.isFinite(Number(args?.limit))
							? Math.min(200, Math.max(1, Math.trunc(Number(args.limit))))
							: config.operationsLimit;
						const summary = await operationSummary(channel, limit, exec?.signal);
						return toolJson({ ok: true, action, bankId: client.bankId, ...summary });
					}
					const operationId = String(args?.operationId ?? "").trim();
					if (!operationId) return toolError(`memory_operations ${action} 需要 operationId`);
					if (action === "retry") {
						const result = await client.retryOperation(operationId, { signal: exec?.signal });
						return toolJson({ ok: true, action, bankId: client.bankId, operationId, result });
					}
					const result = await client.deleteOperation(operationId, { signal: exec?.signal });
					return toolJson({ ok: true, action, bankId: client.bankId, operationId, result });
				} catch (error) {
					log(`memory_operations failed: ${error?.message ?? error}`);
					return toolError(`任务队列操作失败：${error?.message ?? error}`);
				}
			},
		},
	];

	for (const tool of tools) {
		try {
			const dispose = ctx.tools.register(tool);
			ctx.effect(() => dispose);
		} catch (error) {
			log(`工具 ${tool.name} 注册失败：${error?.message ?? error}`);
		}
	}

	// ── 4) 首轮自动召回（注入用户消息，落在缓存边界之后）─────────────────
	if (config.autoRecall) {
		ctx.on(
			"agent/pre-step",
			async (payload, next) => {
				const decision = await next();
				if (decision?.kind !== "enter") return decision;
				if (payload?.step !== 1) return decision;
				// omp 契约 #14：子 agent 复用父级的 bank/标签，但**不做**自动召回/自动落盘。
				if (payload?.agent?.parentAgent) return decision;
				try {
					const channel = await channelFor(payload.agent);
					if (!channel || channel.primed) return decision;
					channel.primed = true;
					const messages = [...decision.messages];
					const query = extractUserPrompt(decision.messages) || extractUserPrompt(payload.messages);
					if (query) {
						try {
							const result = await channel.client.recall({
								query,
								scope: SCOPE.PROJECT,
								signal: payload.signal,
							});
							if (result.facts.length) {
								messages.push({
									id: randomUUID(),
									role: "user",
									content: [
										{
											type: "text",
											text: renderRecallMessage(result.facts, {
												bankId: result.bankId,
												scope: SCOPE.PROJECT,
											}),
										},
									],
									source: { kind: "plugin:dsh-hindsight-memory", form: "recall" },
								});
							}
						} catch (error) {
							log(`自动召回失败（忽略）：${error?.message ?? error}`);
						}
					}
					// 精神模型层：与 omp 对齐（会话首轮注入一次正文）。
					if (config.mentalModels && config.injectMentalModels) {
						const block = await mentalModelBlock(channel, payload.signal);
						if (block) {
							messages.push({
								id: randomUUID(),
								role: "user",
								content: [{ type: "text", text: block }],
								source: { kind: "plugin:dsh-hindsight-memory", form: "mental-models" },
							});
						}
					}
					if (messages.length === decision.messages.length) return decision;
					return { kind: "enter", messages };
				} catch (error) {
					log(`自动召回失败（忽略）：${error?.message ?? error}`);
					return decision;
				}
			},
			{ prepend: false },
		);
	}

	// ── 5) 回合结束自动留存（实验性，默认关闭）──────────────────────────
	if (config.autoRetain) {
		ctx.on("agent/turn-stopping", async (payload) => {
			try {
				// omp 契约 #14：子 agent 不自动落盘。
				if (payload?.agent?.parentAgent) return;
				const channel = await channelFor(payload?.agent);
				if (!channel) return;
				// 对齐 omp：每 N 个回合留一次（默认 3），否则项目层会被对话噪声灌满。
				channel.turnCount = (channel.turnCount ?? 0) + 1;
				const every = Math.max(1, config.retainEveryNTurns);
				if (channel.turnCount % every !== 0) return;
				const messages = payload?.turn?.messages;
				if (!Array.isArray(messages) || messages.length === 0) return;
				const text = messages
					.filter((m) => m?.role === "user" || m?.role === "assistant")
					.map((m) => (typeof m.content === "string" ? m.content : ""))
					.join("\n")
					.trim();
				if (!text) return;
				await channel.client.retain({
					content: sanitizeMemoryText(text.slice(-4000)),
					tier: TIER.PROJECT,
					context: "auto-retain from DSH turn",
					sessionId: payload?.agent?.id,
					signal: payload?.signal,
				});
			} catch (error) {
				log(`自动留存失败（忽略）：${error?.message ?? error}`);
			}
		});
	}
}

export default { name, inject, Config: LiveConfig, apply };
export { MEMORY_PROTOCOL };
