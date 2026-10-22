/**
 * ⭐ 与 omp 的行为契约层（parity core）。
 *
 * 这里只放**纯函数**：不碰网络、不读环境。目的是让"与 omp 一致"这件事可以被
 * 单测钉死，而不是靠联调时肉眼比对。
 *
 * ── omp 侧基准（packages/coding-agent/src/hindsight/bank.ts, client.ts）─────────
 *
 *   projectLabel(directory):
 *     const primary = vcs.repo(directory)?.primaryRoot() ?? null;
 *     return path.basename(primary ?? directory).toLowerCase() || "unknown";
 *
 *   computeBankScope(config, directory):
 *     global            → { bankId: base }
 *     per-project       → { bankId: `${base}-${label}` }
 *     per-project-tagged→ { bankId: base,
 *                           retainTags: [`project:${label}`],
 *                           recallTags: [`project:${label}`],
 *                           recallTagsMatch: "any" }
 *
 *   base = bankIdPrefix ? `${bankIdPrefix}-${bankId}` : bankId     (默认 bankId = "omp")
 *
 * ── Hindsight 服务端标签语义（实测）───────────────────────────────────────────
 *
 *   recall(tags, tags_match):
 *     - tags_match=any        ⇒ 可见 ⟺ 【无 tag】或【至少命中一个请求 tag】
 *     - tags_match=any_strict ⇒ 只看严格带 tag 的
 *     - tags=[] （空列表）    ⇒ 不过滤，返回整库；**没有"只取无标签"的表达方式**
 *
 *   所以：
 *     项目层 + 全局层  = tags=[project:<label>] + any
 *     纯项目层        = tags=[project:<label>] + any_strict
 *     纯全局层        = 只能整库读后客户端按 tags.length === 0 过滤
 */

import { UNKNOWN_PROJECT } from "./label.js";

/** 记忆分层。 */
export const TIER = Object.freeze({
	/** 全局层：所有项目共享（无 tag）。 */
	GLOBAL: "global",
	/** 项目层：仅本项目可见（tag = project:<label>）。 */
	PROJECT: "project",
});

/** 召回范围。 */
export const SCOPE = Object.freeze({
	/** 项目层 + 全局层（默认，与 omp per-project-tagged 的召回完全一致）。 */
	PROJECT: "project",
	/** 仅项目层。 */
	PROJECT_ONLY: "project_only",
	/** 仅全局层（客户端过滤）。 */
	GLOBAL: "global",
});

/** 项目标签前缀。omp 用同一个常量（PROJECT_TAG_PREFIX）。 */
export const PROJECT_TAG_PREFIX = "project:";

/**
 * 计算 bank 基名。
 * @param {{bankId: string, bankIdPrefix?: string}} config
 * @returns {string}
 */
export function baseBankId(config) {
	const base = (config.bankId ?? "").trim() || "omp";
	const prefix = (config.bankIdPrefix ?? "").trim();
	return prefix ? `${prefix}-${base}` : base;
}

/**
 * 计算 bank 与标签（复刻 omp 的 computeBankScope）。
 *
 * @param {{bankId: string, bankIdPrefix?: string, scoping: string}} config
 * @param {string} label 项目标签（小写 basename）。
 * @returns {{bankId: string, retainTags: string[], recallTags: string[], recallTagsMatch: "any"|undefined}}
 */
export function computeBankScope(config, label) {
	const base = baseBankId(config);
	const project = label || UNKNOWN_PROJECT;
	switch (config.scoping) {
		case "global":
			return { bankId: base, retainTags: [], recallTags: [], recallTagsMatch: undefined };
		case "per-project":
			return {
				bankId: `${base}-${project}`,
				retainTags: [],
				recallTags: [],
				recallTagsMatch: undefined,
			};
		case "per-project-tagged":
		default:
			return {
				bankId: base,
				retainTags: [`${PROJECT_TAG_PREFIX}${project}`],
				recallTags: [`${PROJECT_TAG_PREFIX}${project}`],
				recallTagsMatch: "any",
			};
	}
}

/**
 * 写侧盖章：决定这条记忆落在哪一层。
 *
 * 🔴 与 omp 的差别（必须显式承认）：
 *   omp 的 retain **永远**带 project 标签 ⇒ omp **产不出**全局层。
 *   本插件把"层"做成**显式参数**：默认写项目层（与 omp 一致），
 *   只有调用方明确说 global 才不带 tag。
 *
 * @param {{scoping: string}} config
 * @param {string} label 项目标签。
 * @param {string} tier TIER.PROJECT | TIER.GLOBAL
 * @returns {string[]} tags
 */
export function retainTags(config, label, tier = TIER.PROJECT) {
	if (tier === TIER.GLOBAL) return [];
	const scope = computeBankScope(config, label);
	if (scope.retainTags.length > 0) return [...scope.retainTags];
	// per-project 模式下 bank 本身已隔离，标签是冗余的；但打上它可以保证
	// 同一 bank 被多路复用时仍然可判层（且不违反 omp 语义：多带 project tag 无妨）。
	return [`${PROJECT_TAG_PREFIX}${label || UNKNOWN_PROJECT}`];
}

/**
 * 读侧过滤：算出请求用的 tags / tags_match。
 *
 * @param {{scoping: string}} config
 * @param {string} label 项目标签。
 * @param {string} scope SCOPE.*
 * @returns {{tags: string[], tags_match: "any"|"any_strict"|undefined, clientFilter: "untagged"|null}}
 */
export function recallFilter(config, label, scope = SCOPE.PROJECT) {
	const project = label || UNKNOWN_PROJECT;
	const tag = `${PROJECT_TAG_PREFIX}${project}`;

	// global / per-project 模式下没有标签轴，召回就是整 bank。
	if (config.scoping === "global" || config.scoping === "per-project") {
		return { tags: [], tags_match: undefined, clientFilter: null };
	}

	switch (scope) {
		case SCOPE.GLOBAL:
			// 服务端表达不了"只无标签" ⇒ 整库读 + 客户端过滤。
			return { tags: [], tags_match: undefined, clientFilter: "untagged" };
		case SCOPE.PROJECT_ONLY:
			return { tags: [tag], tags_match: "any_strict", clientFilter: null };
		case SCOPE.PROJECT:
		default:
			return { tags: [tag], tags_match: "any", clientFilter: null };
	}
}

/**
 * 判断一条召回结果属于哪一层。
 * @param {{tags?: string[]}} fact
 * @returns {"global"|"project"}
 */
export function tierOf(fact) {
	const tags = Array.isArray(fact?.tags) ? fact.tags.filter(Boolean) : [];
	return tags.length === 0 ? TIER.GLOBAL : TIER.PROJECT;
}

/**
 * 客户端过滤：只保留无标签的（用于"纯全局层"召回）。
 * @param {Array} facts
 * @returns {Array}
 */
export function filterUntagged(facts) {
	return (facts ?? []).filter((f) => tierOf(f) === TIER.GLOBAL);
}

/**
 * 归一化召回结果：抹平不同传输层/服务端的字段差异。
 *
 * 服务端 recall 响应：`{ results: [{ id, text, tags, ... }] }`
 * MCP recall 响应：content[0].text 是 JSON，里面同样是 `{ results: [...] }`
 *
 * @param {unknown} payload
 * @returns {Array<{id?: string, text: string, tags: string[], tier: string, score?: number}>}
 */
export function normalizeFacts(payload) {
	const list = extractList(payload);
	const out = [];
	for (const item of list) {
		if (!item) continue;
		if (typeof item === "string") {
			out.push({ text: item, tags: [], tier: TIER.GLOBAL });
			continue;
		}
		const text = pickText(item);
		if (!text) continue;
		const tags = Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === "string" && t) : [];
		const fact = {
			id: typeof item.id === "string" ? item.id : undefined,
			text,
			tags,
			tier: tierOf({ tags }),
		};
		const score = item.score ?? item.relevance ?? item.similarity;
		if (typeof score === "number") fact.score = score;
		out.push(fact);
	}
	return out;
}

function extractList(payload) {
	if (Array.isArray(payload)) return payload;
	if (!payload || typeof payload !== "object") return [];
	for (const key of ["results", "memories", "items", "facts", "documents"]) {
		const value = payload[key];
		if (Array.isArray(value)) return value;
	}
	// MCP 的 content[0].text 里是 JSON 字符串
	const content = payload.content;
	if (Array.isArray(content) && content.length > 0) {
		const text = content[0]?.text;
		if (typeof text === "string") {
			try {
				return extractList(JSON.parse(text));
			} catch {
				return [];
			}
		}
	}
	return [];
}

function pickText(item) {
	for (const key of ["text", "content", "memory", "body", "summary"]) {
		const value = item[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

/**
 * 截断召回 query。
 *
 * omp 的行为（hindsight/client.ts）：整体截断到 recallMaxQueryChars（默认 800），
 * **保留尾部**（尾部是当前这一句，前面的历史可以丢）。
 *
 * @param {string} query
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateQuery(query, maxChars) {
	const q = String(query ?? "").trim();
	const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : 800;
	if (q.length <= limit) return q;
	return q.slice(q.length - limit);
}

/**
 * 生成写入 body（REST 形态）。MCP 走同构参数。
 *
 * @param {object} options
 * @returns {{items: Array<{content: string, context?: string, tags: string[]}>}}
 */
export function buildRetainPayload({ content, context, tags }) {
	const item = { content: String(content ?? "").trim() };
	const ctx = typeof context === "string" ? context.trim() : "";
	if (ctx) item.context = ctx;
	item.tags = Array.isArray(tags) ? [...tags] : [];
	return { items: [item] };
}
