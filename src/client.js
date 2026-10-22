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
	computeBankScope,
	filterUntagged,
	normalizeFacts,
	recallFilter,
	retainTags,
	truncateQuery,
} from "./parity.js";

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
	async retain({ content, tier = TIER.PROJECT, context, signal } = {}) {
		const text = String(content ?? "").trim();
		if (!text) throw new HindsightError("retain 需要非空 content");
		if (!this.config.writeEnabled) {
			throw new HindsightError("写入已被插件配置禁用（writeEnabled=false）");
		}
		const tags = retainTags(this.config, this.label, tier);
		const ctx = typeof context === "string" && context.trim() ? context.trim() : undefined;

		const result =
			this.config.transport === "mcp"
				? await this.retainViaMcp(text, tags, ctx, signal)
				: await this.retainViaRest(text, tags, ctx, signal);
		return { tags, tier, result };
	}

	async retainViaMcp(content, tags, context, signal) {
		const client = await this.mcpClient({ signal });
		const args = { content, tags };
		if (context) args.context = context;
		return client.callTool("retain", args, { signal });
	}

	async retainViaRest(content, tags, context, signal) {
		const item = { content };
		if (context) item.context = context;
		item.tags = tags;
		return this.postJson(
			`/v1/default/banks/${encodeSegment(this.bankId)}/memories`,
			{ items: [item], async: true },
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
