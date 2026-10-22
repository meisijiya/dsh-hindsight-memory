/**
 * Hindsight 访问层：REST 与 MCP 双传输，共用一套 parity 语义。
 *
 * - `transport: "mcp"`（默认）：走服务端官方 per-bank MCP 端点
 *   `http://<apiUrl>/mcp/<bank>/`，工具名 retain / recall / reflect / list_banks …
 * - `transport: "rest"`：走公开 REST API
 *   `http://<apiUrl>/v1/default/banks/<bank>/memories` 等。
 *
 * 两种传输的**外部行为完全一致**：同样的 bank、同样的标签、同样的分层语义。
 * 差异只在传输细节（这就是"中间层"存在的意义）。
 */

import { McpHttpClient, McpError } from "./mcp.js";
import {
	SCOPE,
	TIER,
	buildRetainPayload,
	computeBankScope,
	filterUntagged,
	localTimestamp,
	normalizeFacts,
	recallFilter,
	retainTags,
	truncateQuery,
} from "./parity.js";
import { flattenTree } from "./pages.js";

/** bank id 里可能有中文 ⇒ 路径段必须 percent-encode。 */
function encodeSegment(value) {
	return encodeURIComponent(String(value ?? ""));
}

export class HindsightError extends Error {
	constructor(message, cause) {
		super(message);
		this.name = "HindsightError";
		if (cause) this.cause = cause;
	}
}

export class HindsightMemoryClient {
	/**
	 * @param {object} options
	 * @param {object} options.config 归一化后的配置。
	 * @param {string} options.label 项目标签（小写）。
	 * @param {(msg: string) => void} [options.log]
	 */
	constructor({ config, label, log = () => {} }) {
		this.config = config;
		this.label = label;
		this.log = log;
		this.scope = computeBankScope(config, label);
		this.mcp = null;
	}

	/** 当前生效的 bank 与标签（与 omp 同一套算法）。 */
	get bankScope() {
		return this.scope;
	}

	get bankId() {
		return this.scope.bankId;
	}

	/** 懒加载 MCP 客户端。 */
	async mcpClient({ signal } = {}) {
		if (!this.mcp) {
			this.mcp = new McpHttpClient({
				url: `${this.config.apiUrl}/mcp/${encodeSegment(this.bankId)}/`,
				timeoutMs: this.config.recallTimeoutMs,
				log: this.log,
			});
		}
		if (!this.mcp.initialized) await this.mcp.initialize({ signal });
		return this.mcp;
	}

	// ───────────────────────────── 读 ─────────────────────────────

	/**
	 * 召回。
	 * @param {object} options
	 * @param {string} options.query
	 * @param {string} [options.scope] SCOPE.*
	 * @param {"low"|"mid"|"high"} [options.budget]
	 * @param {number} [options.maxTokens]
	 * @returns {Promise<{facts: Array, bankId: string, filter: object}>}
	 */
	async recall({ query, scope = SCOPE.PROJECT, budget, maxTokens, signal } = {}) {
		const q = truncateQuery(query, this.config.recallMaxQueryChars);
		if (!q) throw new HindsightError("recall 需要非空 query");
		const filter = recallFilter(this.config, this.label, scope);
		const budgetValue = budget ?? this.config.budget;
		const max = maxTokens ?? this.config.maxTokens;

		const payload =
			this.config.transport === "mcp"
				? await this.recallViaMcp(q, filter, budgetValue, max, signal)
				: await this.recallViaRest(q, filter, budgetValue, max, signal);

		let facts = normalizeFacts(payload);
		if (filter.clientFilter === "untagged") facts = filterUntagged(facts);
		return { facts, bankId: this.bankId, filter };
	}

	async recallViaMcp(query, filter, budget, maxTokens, signal) {
		const client = await this.mcpClient({ signal });
		const args = {
			query,
			budget,
			max_tokens: maxTokens,
			types: this.config.types,
		};
		if (filter.tags.length > 0) args.tags = filter.tags;
		if (filter.tags_match) args.tags_match = filter.tags_match;
		return client.callTool("recall", args, { signal });
	}

	async recallViaRest(query, filter, budget, maxTokens, signal) {
		const body = {
			query,
			budget,
			max_tokens: maxTokens,
			types: this.config.types,
		};
		if (filter.tags.length > 0) body.tags = filter.tags;
		if (filter.tags_match) body.tags_match = filter.tags_match;
		return this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/memories/recall`,
			body,
			{ signal, timeoutMs: this.config.recallTimeoutMs },
		);
	}

	// ───────────────────────────── 写 ─────────────────────────────

	/**
	 * 写入一条记忆。
	 * @param {object} options
	 * @param {string} options.content
	 * @param {string} [options.tier] TIER.PROJECT | TIER.GLOBAL
	 * @param {string} [options.context]
	 */
	async retain({ content, tier = TIER.PROJECT, context, sessionId, signal } = {}) {
		const text = String(content ?? "").trim();
		if (!text) throw new HindsightError("retain 需要非空 content");
		if (!this.config.writeEnabled) {
			throw new HindsightError("写入已被插件配置禁用（writeEnabled=false）");
		}
		const tags = retainTags(this.config, this.label, tier);
		const ctx = typeof context === "string" && context.trim() ? context.trim() : undefined;
		// 对齐 omp：写入带本地时区时间戳 + metadata.session_id，便于按会话回溯。
		const timestamp = localTimestamp();
		const session = sessionId ? String(sessionId) : undefined;

		const result =
			this.config.transport === "mcp"
				? await this.retainViaMcp(text, tags, ctx, { timestamp, sessionId: session }, signal)
				: await this.retainViaRest(text, tags, ctx, { timestamp, sessionId: session }, signal);
		return { tags, tier, timestamp, result };
	}

	async retainViaMcp(content, tags, context, extra, signal) {
		const client = await this.mcpClient({ signal });
		const args = { content, tags };
		if (context) args.context = context;
		if (extra?.timestamp) args.timestamp = extra.timestamp;
		if (extra?.sessionId) args.metadata = { session_id: extra.sessionId };
		return client.callTool("retain", args, { signal });
	}

	async retainViaRest(content, tags, context, extra, signal) {
		const payload = buildRetainPayload({
			content,
			context,
			tags,
			timestamp: extra?.timestamp,
			sessionId: extra?.sessionId,
		});
		return this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/memories`,
			{ ...payload, async: true },
			{ signal, timeoutMs: this.config.retainTimeoutMs },
		);
	}

	// ─────────────────────────── 综合问答 ───────────────────────────

	/**
	 * reflect：让 Hindsight 侧模型基于记忆库做综合问答。
	 * @param {object} options
	 * @param {string} options.query
	 * @param {string} [options.scope]
	 */
	async reflect({ query, scope = SCOPE.PROJECT, budget, signal } = {}) {
		const q = truncateQuery(query, this.config.recallMaxQueryChars);
		if (!q) throw new HindsightError("reflect 需要非空 query");
		const filter = recallFilter(this.config, this.label, scope);
		const budgetValue = budget ?? this.config.reflectBudget;

		if (this.config.transport === "mcp") {
			const client = await this.mcpClient({ signal });
			const args = { query: q, budget: budgetValue };
			if (filter.tags.length > 0) args.tags = filter.tags;
			if (filter.tags_match) args.tags_match = filter.tags_match;
			return client.callTool("reflect", args, { signal });
		}
		const body = { query: q, budget: budgetValue };
		if (filter.tags.length > 0) body.tags = filter.tags;
		if (filter.tags_match) body.tags_match = filter.tags_match;
		return this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/reflect`,
			body,
			{ signal, timeoutMs: this.config.reflectTimeoutMs },
		);
	}

	// ─────────────────────────── 状态 ───────────────────────────

	/**
	 * bank 概览 + 体检告警。
	 *
	 * 报告 §6 的坑：同名空 legacy bank 会伪装成「召回为空」，
	 * 所以每次判断召回问题前都要先核对 bank 的 fact_count。
	 *
	 * @param {object} options
	 * @returns {Promise<{bankId: string, factCount: number|null, documentCount: number|null, totalBanks: number, warnings: string[]}>}
	 */
	async bankOverview({ signal } = {}) {
		const out = {
			bankId: this.bankId,
			factCount: null,
			documentCount: null,
			totalBanks: 0,
			warnings: [],
		};
		try {
			const payload = await this.getJson("/v1/default/banks", { signal });
			const list = Array.isArray(payload)
				? payload
				: Array.isArray(payload?.banks)
					? payload.banks
					: Array.isArray(payload?.items)
						? payload.items
						: [];
			out.totalBanks = list.length;
			const target = list.find((b) => (b?.bank_id ?? b?.id) === this.bankId);
			if (target) {
				out.factCount = target?.fact_count ?? null;
				out.documentCount = target?.document_count ?? null;
			} else {
				out.warnings.push(
					`bank "${this.bankId}" 不在服务端 bank 列表里（现有：${list
						.map((b) => b?.bank_id ?? b?.id)
						.join(", ") || "无"}）`,
				);
			}
			if (out.factCount === 0) {
				out.warnings.push(
					`bank "${this.bankId}" 的 fact_count = 0；同名空 legacy bank 会伪装成「召回为空」，先核对 bank 名字再下结论`,
				);
			}
			const siblings = list
				.map((b) => b?.bank_id ?? b?.id)
				.filter((id) => id && id !== this.bankId && String(id).includes(String(this.bankId).split("-")[0]));
			if (siblings.length > 0) {
				out.warnings.push(`存在同名近邻 bank：${siblings.join(", ")}（注意 legacy 空库干扰）`);
			}
		} catch (error) {
			out.warnings.push(`读取 bank 列表失败：${error?.message ?? error}`);
		}
		return out;
	}

	/** 健康与 bank 列表。 */
	async status({ signal } = {}) {
		const out = { transport: this.config.transport, bankId: this.bankId, label: this.label };
		try {
			if (this.config.transport === "mcp") {
				const client = await this.mcpClient({ signal });
				const tools = await client.listTools({ signal });
				out.tools = tools.map((t) => t?.name).filter(Boolean);
				out.ok = true;
			} else {
				const banks = await this.getJson("/v1/default/banks", { signal });
				// 服务端返回 { banks: [...] }（也兼容裸数组）。
				const list = Array.isArray(banks) ? banks : Array.isArray(banks?.banks) ? banks.banks : [];
				out.banks = list.map((b) => ({
					bankId: b?.bank_id ?? b?.id,
					factCount: b?.fact_count,
				}));
				out.ok = true;
			}
		} catch (error) {
			out.ok = false;
			out.error = error?.message ?? String(error);
		}
		return out;
	}

	// ─────────────────── 记忆卫生（只作用于共享 bank）───────────────────
	// 这些接口 MCP 工具面里没有（服务端已收窄到 7 个安全工具），
	// 所以卫生动作走 REST——而且**必须**走 REST：只有 bank 级操作才能让
	// omp 与 DSH 同时受益（两端读的是同一个 bank）。

	/** 列出 bank 内的事实。 */
	async listFacts({ limit = 500, signal } = {}) {
		return this.getJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/memories/list?limit=${encodeURIComponent(String(limit))}`,
			{ signal, timeoutMs: this.config.recallTimeoutMs },
		);
	}

	/** 作废或恢复一条事实（state: invalidated ⇄ valid，服务端保证可逆）。 */
	async setFactState(id, state, { signal } = {}) {
		return this.patchJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/memories/${encodeSegment(id)}`,
			{ state },
			{ signal, timeoutMs: this.config.retainTimeoutMs },
		);
	}

	/** 触发 bank 级 consolidation（observation 合并）。 */
	async consolidate({ signal } = {}) {
		return this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/consolidate`,
			{},
			{ signal, timeoutMs: this.config.reflectTimeoutMs },
		);
	}

	/** observation scope 统计（每个 scope 的 observation 条数）。 */
	async observationScopes({ signal } = {}) {
		return this.getJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/observations/scopes`,
			{ signal, timeoutMs: this.config.recallTimeoutMs },
		);
	}

	/** 预览 consolidation 策略命中了哪些 scope。 */
	async previewStrategies(strategies, { signal } = {}) {
		return this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/consolidation-strategies/preview`,
			{ strategies, sample_limit: 10 },
			{ signal, timeoutMs: this.config.reflectTimeoutMs },
		);
	}

	/** 读 bank 配置（consolidation 策略与口径都在这里）。 */
	async bankConfig({ signal } = {}) {
		return this.getJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/config`,
			{ signal, timeoutMs: this.config.recallTimeoutMs },
		);
	}

	// ────────────────────── Mental model 层 ──────────────────────
	// 🔴 这些接口**只走 REST**：服务端把 MCP 工具面收窄到 7 个安全工具，
	//    mental model 的管理接口不在其中（它们是写操作，会改 bank 的画像）。
	//    报告 §6.2：DSH 侧**不要** PUT /banks 覆写 mission；mental model 是可以写的。

	/** 列 mental model（detail=metadata | content）。 */
	async listMentalModels({ detail = "metadata", limit = 200, signal } = {}) {
		const query = new URLSearchParams({
			detail: String(detail),
			limit: String(limit),
			offset: "0",
		});
		return this.getJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/mental-models?${query.toString()}`,
			{ signal, timeoutMs: this.config.recallTimeoutMs },
		);
	}

	/** 读单个 mental model。 */
	async getMentalModel(id, { signal } = {}) {
		return this.getJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/mental-models/${encodeSegment(id)}`,
			{ signal, timeoutMs: this.config.recallTimeoutMs },
		);
	}

	/**
	 * 创建 mental model（**仅创建**）：重复 id 返回 409，且不会改写已有模型的 tags。
	 * @param {object} spec { id, name, source_query, tags?, max_tokens, trigger }
	 */
	async createMentalModel(spec, { signal } = {}) {
		return this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/mental-models`,
			spec,
			{ signal, timeoutMs: this.config.retainTimeoutMs },
		);
	}

	/** 改 mental model（POST 改不了 tags，只能 PATCH）。 */
	async patchMentalModel(id, patch, { signal } = {}) {
		return this.patchJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/mental-models/${encodeSegment(id)}`,
			patch,
			{ signal, timeoutMs: this.config.retainTimeoutMs },
		);
	}

	/** 触发增量刷新（异步，返回 operation_id）。 */
	async refreshMentalModel(id, { signal } = {}) {
		return this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/mental-models/${encodeSegment(id)}/refresh`,
			{},
			{ signal, timeoutMs: this.config.retainTimeoutMs },
		);
	}

	// ────────────────────── 运维观测（operations） ──────────────────────
	// 报告 §6.10：**失败任务不会自动重试**（retry_count=0、next_retry_at=null），
	// 必须主动 retry / delete；不观测就会出现「写进去了但查不到」的静默故障。

	/** 列 operation（异步任务队列）。 */
	async listOperations({ limit = 20, signal } = {}) {
		const query = new URLSearchParams({ limit: String(limit), offset: "0" });
		return this.getJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/operations?${query.toString()}`,
			{ signal, timeoutMs: this.config.recallTimeoutMs },
		);
	}

	/** 重试一个 operation。 */
	async retryOperation(operationId, { signal } = {}) {
		return this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/operations/${encodeSegment(operationId)}/retry`,
			{},
			{ signal, timeoutMs: this.config.retainTimeoutMs },
		);
	}

	/** 删除一个 operation（真删；报告 §10 用它清僵尸 pending 行）。 */
	async deleteOperation(operationId, { signal } = {}) {
		const response = await this.fetchWithTimeout(
			`/v1/default/banks/${encodeSegment(this.bankId)}/operations/${encodeSegment(operationId)}`,
			{ method: "DELETE", signal, timeoutMs: this.config.retainTimeoutMs },
		);
		return this.parse(response);
	}

	/** bank 统计（total_nodes / pending_operations / failed_operations …）。 */
	async bankStats({ signal } = {}) {
		return this.getJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/stats`,
			{ signal, timeoutMs: this.config.recallTimeoutMs },
		);
	}

	// ─────────────────── 知识页（knowledge pages）层 ───────────────────
	// 🔴 只走 REST：服务端把 MCP 工具面收窄到 7 个安全工具，知识页接口不在其中。
	//    这些接口是**服务端的一等能力**，不需要官方 coding-agents 包也能用。

	/** 读知识库树（roots + 子树）。 */
	async listKnowledgeTree({ signal } = {}) {
		return this.getJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/knowledge-base/tree`,
			{ signal, timeoutMs: this.config.recallTimeoutMs },
		);
	}

	/**
	 * 检索知识页（服务端 BM25 + 向量 RRF）。
	 * tags / tags_match 与 recall 同一套白名单语义：无标签 = 全局层，任何项目可见。
	 */
	async searchKnowledgePages({ query, limit = 5, tags = [], tagsMatch = "any", signal } = {}) {
		const params = new URLSearchParams({
			q: String(query ?? ""),
			limit: String(limit),
		});
		const tagList = Array.isArray(tags) ? tags.filter(Boolean) : [];
		if (tagList.length > 0) {
			params.set("tags", tagList.join(","));
			params.set("tags_match", tagsMatch);
		}
		return this.getJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/knowledge-base/search?${params.toString()}`,
			{ signal, timeoutMs: this.config.recallTimeoutMs },
		);
	}

	/** 读一页正文（KnowledgePageResponse：id/name/type/markdown/tags…）。 */
	async readKnowledgePage(id, { signal } = {}) {
		return this.getJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/knowledge-base/pages/${encodeSegment(id)}`,
			{ signal, timeoutMs: this.config.recallTimeoutMs },
		);
	}

	/** 建一页（服务端按 source_query 合成正文，异步）。 */
	async createKnowledgePage(request, { signal } = {}) {
		return this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/knowledge-base/pages`,
			request,
			{ signal, timeoutMs: this.config.reflectTimeoutMs },
		);
	}

	/** 确保存在一个同名文件夹，返回 {id, created}。 */
	async ensureFolder(name, { signal } = {}) {
		const tree = await this.listKnowledgeTree({ signal });
		const flat = flattenTree(tree);
		const hit = flat.folders.find((folder) => folder.name === name);
		if (hit?.id) return { id: hit.id, created: false };
		const created = await this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/knowledge-base/folders`,
			{ name },
			{ signal, timeoutMs: this.config.reflectTimeoutMs },
		);
		return { id: created?.id ?? null, created: true };
	}

	// ─────────────────── 维护层（改 / 退役 / 纠正）───────────────────
	// 服务端事实层没有 DELETE，只有软退役（state=invalidated，可改回 valid）；
	// 知识页与精神模型才有真正的 DELETE。这些接口 MCP 工具面里没有，走 REST。

	/** 改写一条事实（text 会重嵌入并丢弃其派生 observation）。 */
	async updateFact(id, patch, { signal } = {}) {
		return this.patchJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/memories/${encodeSegment(id)}`,
			patch,
			{ signal, timeoutMs: this.config.retainTimeoutMs },
		);
	}

	/** 软退役（invalidated）或恢复（valid）一条事实，并留下原因。 */
	async setFactStateWithReason(id, state, reason, { signal } = {}) {
		return this.updateFact(id, { state, reason }, { signal });
	}

	/** 事实的变更历史。 */
	async factHistory(id, { signal } = {}) {
		return this.getJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/memories/${encodeSegment(id)}/history`,
			{ signal, timeoutMs: this.config.recallTimeoutMs },
		);
	}

	/**
	 * 写入前预演抽取（不落库）。
	 *
	 * 🔴 服务端契约：body 必填 `content`（字符串或内容块数组），**没有 items 字段**。
	 *    所以这里把 items 归一成 content：单条 → 字符串；多条 → 内容块数组。
	 */
	async dryRunExtract(items, { signal } = {}) {
		const list = Array.isArray(items) ? items : [items];
		const texts = list
			.map((item) => (typeof item === "string" ? item : String(item?.content ?? "")))
			.map((text) => text.trim())
			.filter(Boolean);
		const body =
			texts.length > 1
				? { content: texts.map((text) => ({ type: "text", text })) }
				: { content: texts[0] ?? "" };
		const context = list.find(
			(item) => item && typeof item === "object" && item?.context,
		)?.context;
		if (context) body.context = String(context);
		return this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/memories/dry-run-extract`,
			body,
			{ signal, timeoutMs: this.config.reflectTimeoutMs },
		);
	}

	/** 改一个知识页节点。 */
	async updateKnowledgeNode(id, patch, { signal } = {}) {
		return this.patchJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/knowledge-base/nodes/${encodeSegment(id)}`,
			patch,
			{ signal, timeoutMs: this.config.reflectTimeoutMs },
		);
	}

	/** 删一个知识页节点。 */
	async deleteKnowledgeNode(id, { signal } = {}) {
		return this.deleteJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/knowledge-base/nodes/${encodeSegment(id)}`,
			{ signal, timeoutMs: this.config.reflectTimeoutMs },
		);
	}

	/** 删一个精神模型。 */
	async deleteMentalModel(id, { signal } = {}) {
		return this.deleteJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/mental-models/${encodeSegment(id)}`,
			{ signal, timeoutMs: this.config.reflectTimeoutMs },
		);
	}

	/** 清空一个精神模型的正文。 */
	async clearMentalModel(id, { signal } = {}) {
		return this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/mental-models/${encodeSegment(id)}/clear`,
			{},
			{ signal, timeoutMs: this.config.reflectTimeoutMs },
		);
	}

	/** 预演精神模型刷新（只算不落库）：看这次刷新会得到什么。 */
	async dryRunRefreshMentalModel(id, { signal } = {}) {
		return this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/mental-models/${encodeSegment(id)}/dry-run-refresh`,
			{},
			{ signal, timeoutMs: this.config.reflectTimeoutMs },
		);
	}

	// ────────────────────────── HTTP 工具 ──────────────────────────

	async patchJson(path, body, { signal, timeoutMs } = {}) {
		const response = await this.fetchWithTimeout(path, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
			timeoutMs,
		});
		return this.parse(response);
	}

	async postJson(path, body, { signal, timeoutMs } = {}) {
		const response = await this.fetchWithTimeout(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
			timeoutMs,
		});
		return this.parse(response);
	}

	async deleteJson(path, { signal, timeoutMs } = {}) {
		const response = await this.fetchWithTimeout(path, { method: "DELETE", signal, timeoutMs });
		return this.parse(response);
	}

	async getJson(path, { signal, timeoutMs } = {}) {
		const response = await this.fetchWithTimeout(path, { method: "GET", signal, timeoutMs });
		return this.parse(response);
	}

	async fetchWithTimeout(path, { method, headers, body, signal, timeoutMs }) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs ?? 30_000);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await fetch(`${this.config.apiUrl}${path}`, {
				method,
				headers,
				body,
				signal: controller.signal,
			});
		} catch (error) {
			if (error?.name === "AbortError") {
				throw new HindsightError(`Hindsight 请求超时（${timeoutMs ?? 30_000}ms）：${path}`);
			}
			throw new HindsightError(
				`Hindsight 服务不可达：${this.config.apiUrl}${path}（${error?.message ?? error}）`,
				error,
			);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async parse(response) {
		const text = await response.text();
		if (!response.ok) {
			throw new HindsightError(`Hindsight HTTP ${response.status}: ${text.slice(0, 400)}`);
		}
		if (!text.trim()) return {};
		try {
			return JSON.parse(text);
		} catch {
			return { raw: text };
		}
	}
}

export { McpError };
