/**
 * 知识页（knowledge pages）与 initiative（正在做的事）层——纯函数，无 I/O。
 *
 * 🔴 为什么要自己写，而不是装官方的 @vectorize-io/hindsight-coding-agents：
 *   知识页与 initiative 本来就是**服务端一等能力**（/knowledge-base 树 + 合成正文），
 *   官方包只是给它们套了一层工具壳。我们自己写这层壳，才能守住双层标签约定：
 *     ① 产出必须盖 project:<小写仓库名>，否则 omp 的 per-project-tagged 召回看不到；
 *     ② 绝不沿用官方那套 source:/harness: 标签（那是"谁写的"标记，不是隔离边界）；
 *     ③ 写走 async + metadata.session_id，与现有 retain 口径一致。
 *
 * 术语：
 *   - 知识页（page）= 服务端 /knowledge-base 树里的长文节点；给它 source_query
 *     （这页回答什么问题），服务端按 trigger 合成正文。
 *   - initiative = 一篇被跟踪的「正在做的事」页 + 一条 marker 事实，页与事实互链。
 */

import { TIER } from "./parity.js";

/** initiative 页默认放在这个文件夹下。 */
export const INITIATIVE_FOLDER = "Initiatives";

/** initiative 页的固定附加标签（官方也用这个）。 */
export const INITIATIVE_TAG = "knowledge:feature-work";

/** 页面正文合成的 token 上限（服务端硬下限 256）。 */
export const PAGE_MAX_TOKENS = 2000;

/** initiative 页的刷新触发器：增量 + 合并后刷新（与 omp 的 mental model 同口径）。 */
export const DEFAULT_PAGE_TRIGGER = {
	mode: "delta",
	refresh_after_consolidation: true,
};

/**
 * 标题 → 稳定 slug。
 *
 * 与 omp 的 mental model id 不同：**不做 ASCII 过滤**——中文项目名必须保留，
 * 否则「随便问问」会退化成通用名，导致与别的项目撞 id。
 * @param {string} text 标题。
 * @param {string} [fallback] 空标题时的回落名。
 * @returns {string}
 */
export function slugify(text, fallback = "initiative") {
	const raw = String(text ?? "").trim().toLowerCase();
	const slug = raw
		.replace(/[\s\u3000]+/g, "-")
		.replace(/[^\p{Letter}\p{Number}-]+/gu, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || fallback;
}

/**
 * initiative 页的 source_query：固定问句，服务端按它合成正文。
 * @param {string} title 计划标题。
 * @returns {string}
 */
export function initiativeSourceQuery(title) {
	const name = String(title ?? "").trim() || "当前工作";
	return `当前进行中的工作「${name}」的目标、进展、待办与已知风险是什么？请基于本项目的事实与决策汇总。`;
}

/**
 * 标签合并：项目标签在前，附加标签在后，去重。
 * @param {string[]} projectTags 项目层标签（project:<小写名>）。
 * @param {string[]} [extraTags] 附加标签。
 * @returns {string[]}
 */
export function pageTags(projectTags = [], extraTags = []) {
	const out = [];
	for (const tag of [...(projectTags ?? []), ...(extraTags ?? [])]) {
		const value = String(tag ?? "").trim();
		if (value && !out.includes(value)) out.push(value);
	}
	return out;
}

/**
 * 归一化标签数组。
 * @param {unknown} tags 原始标签。
 * @returns {string[]}
 */
export function normalizeTags(tags) {
	if (!Array.isArray(tags)) return [];
	return tags.map((tag) => String(tag ?? "").trim()).filter(Boolean);
}

/**
 * 建页请求体（服务端 CreatePageRequest：name / source_query 必填）。
 * @param {object} options
 * @param {string} options.title 页标题。
 * @param {string} options.sourceQuery 这页回答什么问题。
 * @param {string[]} [options.tags] 页标签。
 * @param {string|null} [options.parentId] 父文件夹 id。
 * @param {number} [options.maxTokens] 正文合成上限。
 * @param {object|null} [options.trigger] 刷新触发器。
 * @returns {object}
 */
export function buildPageRequest({
	title,
	sourceQuery,
	tags = [],
	parentId = null,
	maxTokens = PAGE_MAX_TOKENS,
	trigger = null,
} = {}) {
	const body = {
		name: String(title ?? "").trim(),
		source_query: String(sourceQuery ?? "").trim(),
		tags: pageTags(tags),
		max_tokens: Math.max(256, Math.trunc(Number(maxTokens) || PAGE_MAX_TOKENS)),
	};
	if (parentId) body.parent_id = String(parentId);
	if (trigger) body.trigger = trigger;
	return body;
}

/**
 * 把服务端的知识库树展平成 {folders, pages}。
 * @param {object} tree KnowledgeTreeResponse（{roots:[KnowledgeNode]}）。
 * @returns {{folders: Array, pages: Array}}
 */
export function flattenTree(tree) {
	const folders = [];
	const pages = [];
	const walk = (nodes, depth, parentId) => {
		for (const node of nodes ?? []) {
			if (!node || typeof node !== "object") continue;
			const id = String(node.id ?? "");
			const name = String(node.name ?? "");
			const kind = String(node.kind ?? node.type ?? "");
			if (kind === "folder") {
				folders.push({ id, name, parentId: parentId ?? null, depth });
			} else {
				pages.push({
					id,
					name,
					kind: kind || "page",
					parentId: parentId ?? null,
					depth,
					tags: normalizeTags(node.tags),
					isStale: node.is_stale === true,
					lastRefreshFailedAt: node.last_refresh_failed_at ?? null,
				});
			}
			if (Array.isArray(node.children)) walk(node.children, depth + 1, id || parentId);
		}
	};
	const roots = Array.isArray(tree?.roots) ? tree.roots : Array.isArray(tree) ? tree : [];
	walk(roots, 0, null);
	return { folders, pages };
}

/**
 * 按本项目口径过滤页：带本项目标签的，或**完全无标签**的（全局层）。
 *
 * 与 recall 的白名单语义一致：无标签 = 全局层，任何项目都能看到。
 * @param {Array} items 页列表。
 * @param {string[]} [projectTags] 本项目标签。
 * @returns {Array}
 */
export function filterPagesByScope(items, projectTags = []) {
	const wanted = normalizeTags(projectTags);
	return (items ?? []).filter((item) => {
		const tags = normalizeTags(item?.tags);
		if (tags.length === 0) return true;
		if (wanted.length === 0) return true;
		return tags.some((tag) => wanted.includes(tag));
	});
}

/**
 * 检索结果归一化（服务端返回形状各版本略有差异，容错处理）。
 * @param {object} raw KnowledgePageSearchResponse。
 * @returns {Array}
 */
export function normalizeSearchResults(raw) {
	const list = Array.isArray(raw?.results)
		? raw.results
		: Array.isArray(raw?.items)
			? raw.items
			: Array.isArray(raw)
				? raw
				: [];
	return list.map((item) => ({
		id: String(item?.id ?? item?.page_id ?? ""),
		name: String(item?.name ?? item?.title ?? ""),
		kind: String(item?.kind ?? item?.type ?? "page"),
		tags: normalizeTags(item?.tags),
		snippet: String(item?.snippet ?? item?.description ?? "").slice(0, 400),
		score: typeof item?.score === "number" ? item.score : null,
	}));
}

/**
 * initiative 标记事实的正文。
 * @param {string} title 计划标题。
 * @param {string} pageId 页 id。
 * @returns {string}
 */
export function initiativeMarkerContent(title, pageId) {
	const name = String(title ?? "").trim() || "当前工作";
	return `Initiative「${name}」进行中，跟踪页 [[page:${pageId}]]。`;
}

/**
 * initiative 标记事实的 context（与服务端 [[page:<id>]] 链接格式一致）。
 * @param {string} pageId 页 id。
 * @returns {string}
 */
export function initiativeMarkerContext(pageId) {
	return `initiative marker for [[page:${pageId}]]`;
}

/**
 * 从事实列表里挑出 initiative 标记事实。
 * @param {Array} facts 事实列表（memories/list 的条目）。
 * @returns {Array}
 */
export function findInitiativeMarkers(facts) {
	return (facts ?? []).filter((fact) => {
		const context = String(fact?.context ?? "");
		return context.includes("initiative marker for [[page:");
	});
}

/**
 * initiative 标记事实该写到哪一层：项目层（与页同项目）。
 * @returns {string} TIER.PROJECT
 */
export function initiativeMarkerTier() {
	return TIER.PROJECT;
}
