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
import { Config } from "./schema.js";
import { resolveProjectLabel } from "./label.js";
import { HindsightMemoryClient } from "./client.js";
import { SCOPE, TIER } from "./parity.js";
import { normalizeScope, sanitizeMemoryText, sanitizeTags } from "./sanitize.js";
import {
	MEMORY_PROTOCOL,
	buildPromptSection,
	extractUserPrompt,
	renderRecallMessage,
} from "./prompt.js";

export const name = "hindsight-memory";

/** 依赖的服务：工具注册、系统提示词段。
 *  注意：**不**把 workingDirectory 写进 inject——服务缺失时会让整个 profile 装载失败，
 *  而记忆只是增强。工作目录改为「能取到就用，取不到就回落 session.cwd」的柔性策略。 */
export const inject = ["tools", "systemPrompt"];

export { Config };

const JSON_OBJECT_OUTPUT = { type: "object", additionalProperties: true };

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
 * 插件入口。
 * @param {object} ctx Cordis 上下文。
 * @param {object} rawConfig 配置。
 */
export async function apply(ctx, rawConfig = {}) {
	const config = normalizeConfig(rawConfig);
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
		const channel = { dir, label, client, primed: false };
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

	// ── 3) 工具（一次注册，模型可见面恒定）──────────────────────────────
	const requireChannel = async (exec) => {
		const agent = exec?.agent;
		if (!agent) throw new Error("记忆工具需要活动的 DSH agent");
		const channel = await channelFor(agent);
		if (!channel) throw new Error("无法解析当前会话的工作目录");
		return channel;
	};

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
				"检查记忆服务连通性、当前 bank、项目标签与各层事实数量。用于排查「记忆读不到 / 写不进去」。",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			output: { schema: JSON_OBJECT_OUTPUT, render: (_args, value) => toolJson(value).content },
			execute: async (_args, exec) => {
				try {
					const channel = await requireChannel(exec);
					const status = await channel.client.status({ signal: exec?.signal });
					return toolJson({
						...status,
						projectLabel: channel.label,
						workingDirectory: channel.dir,
						scoping: config.scoping,
						writeEnabled: config.writeEnabled,
					});
				} catch (error) {
					return toolError(`状态查询失败：${error?.message ?? error}`);
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
					const query = extractUserPrompt(decision.messages) || extractUserPrompt(payload.messages);
					if (!query) return decision;
					const result = await channel.client.recall({
						query,
						scope: SCOPE.PROJECT,
						signal: payload.signal,
					});
					if (!result.facts.length) return decision;
					const message = {
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
					};
					return {
						kind: "enter",
						messages: [...decision.messages, message],
					};
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
					signal: payload?.signal,
				});
			} catch (error) {
				log(`自动留存失败（忽略）：${error?.message ?? error}`);
			}
		});
	}
}

export default { name, inject, Config, apply };
export { MEMORY_PROTOCOL };
