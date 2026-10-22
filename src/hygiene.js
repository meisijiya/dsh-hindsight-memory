/**
 * 记忆卫生（memory hygiene）：在**共享 bank** 上做去重与整理。
 *
 * 🔴 为什么放在 bank 层，而不是某个 agent 的本地层：
 *   omp 与 DSH 写的是同一个 Hindsight bank，任何在 bank 上做的整理，
 *   两端**同时受益**；放在某一侧做 ⇒ 行为立刻分裂（用户明确不接受）。
 *   这也是 omp 侧缺失的能力：实测 omp 二进制里没有任何去重/清理逻辑，
 *   所以「整理」必须由中间层插件提供，并且只能作用于共享 bank。
 *
 * 本模块是**纯函数**（无 I/O），便于单测；真正的 HTTP 调用在 client.js。
 */

/** 归一化文本用于「是否同一句」的快速比较。 */
export function normalizeForCompare(text) {
	return String(text ?? "")
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, "")
		.trim();
}

/**
 * 分词：拉丁词 + CJK 二元组。
 * 中文没有空格，按字符二元组切才能让 Jaccard 有意义。
 */
export function tokenize(text) {
	const normalized = String(text ?? "").toLowerCase();
	const tokens = new Set();
	for (const word of normalized.match(/[a-z0-9_]+/g) ?? []) {
		if (word.length > 1 || /[0-9]/.test(word)) tokens.add(word);
	}
	const cjk = normalized.replace(/[a-z0-9_\s]/g, "");
	for (let i = 0; i < cjk.length - 1; i += 1) tokens.add(cjk.slice(i, i + 2));
	if (cjk.length === 1) tokens.add(cjk);
	return tokens;
}

/** Jaccard 相似度。 */
export function similarity(a, b) {
	const ta = a instanceof Set ? a : tokenize(a);
	const tb = b instanceof Set ? b : tokenize(b);
	if (ta.size === 0 && tb.size === 0) return 1;
	if (ta.size === 0 || tb.size === 0) return 0;
	let inter = 0;
	for (const token of ta) if (tb.has(token)) inter += 1;
	const union = ta.size + tb.size - inter;
	return union === 0 ? 0 : inter / union;
}

/** 标签签名：同层才算重复（项目层与全局层是两种语义，不能互删）。 */
export function tagSignature(fact) {
	const tags = Array.isArray(fact?.tags) ? [...fact.tags].map(String).sort() : [];
	return tags.join("|");
}

/** 事实类型（world / experience / observation）。 */
export function factType(fact) {
	return String(fact?.fact_type ?? fact?.memory_type ?? "world");
}

/**
 * 去重签名：**类型 + 标签**。
 *
 * 为什么类型也要进签名：
 *   服务端每次 retain 会同时产出 world 原始事实与 observation 归纳事实，
 *   两者文本高度相似但语义不同（一个是原文，一个是归纳）。
 *   把它们当重复处理 = 把服务端的归纳层删掉 ⇒ 反而变差。
 */
export function dupSignature(fact) {
	return `${factType(fact)}::${tagSignature(fact)}`;
}

/** 事实的新旧排序依据（越新越靠前）。 */
function recency(fact) {
	// 成员对象由 findDuplicateGroups 产出，用驼峰键；服务端原对象用下划线键。
	const raw =
		fact?.updated_at ??
		fact?.updatedAt ??
		fact?.created_at ??
		fact?.createdAt ??
		fact?.timestamp ??
		fact?.stored_at ??
		"";
	const value = typeof raw === "number" ? raw : Date.parse(String(raw));
	return Number.isFinite(value) ? value : 0;
}

/** 事实正文（不同服务端字段名都兜住）。 */
export function factText(fact) {
	return String(fact?.text ?? fact?.content ?? fact?.memory ?? fact?.body ?? "").trim();
}

/**
 * 找出重复组。
 *
 * @param {Array} facts 事实列表（至少含 id/text/tags）。
 * @param {object} [options]
 * @param {number} [options.threshold] 相似度阈值，默认 0.9。
 * @param {number} [options.maxFacts] 参与比较的最大条数，默认 500（防 O(n²) 爆掉）。
 * @returns {{ groups: Array, crossScope: Array, scanned: number }}
 */
export function findDuplicateGroups(
	facts,
	{ threshold = 0.9, maxFacts = 500, includeObservations = false } = {},
) {
	const list = Array.isArray(facts) ? facts : [];
	const scanned = list.slice(0, maxFacts);

	/** @type {Map<string, Array>} */
	const buckets = new Map();
	for (const fact of scanned) {
		const text = factText(fact);
		if (!text) continue;
		// observation 是服务端的归纳层，**默认不动**：合并它等于删掉归纳成果。
		if (!includeObservations && factType(fact) === "observation") continue;
		const key = dupSignature(fact);
		if (!buckets.has(key)) buckets.set(key, []);
		buckets.get(key).push(fact);
	}

	const groups = [];
	const consumed = new Set();

	for (const bucket of buckets.values()) {
		if (bucket.length < 2) continue;
		const texts = bucket.map((f) => normalizeForCompare(factText(f)));
		const tokens = bucket.map((f) => tokenize(factText(f)));
		for (let i = 0; i < bucket.length; i += 1) {
			if (consumed.has(bucket[i]?.id)) continue;
			const members = [bucket[i]];
			for (let j = i + 1; j < bucket.length; j += 1) {
				if (consumed.has(bucket[j]?.id)) continue;
				const exact = texts[i] === texts[j];
				const score = exact ? 1 : similarity(tokens[i], tokens[j]);
				if (score >= threshold) {
					members.push(bucket[j]);
					consumed.add(bucket[j].id);
				}
			}
			if (members.length > 1) {
				consumed.add(bucket[i].id);
				groups.push({
					signature: dupSignature(bucket[i]),
					scope: tagSignature(bucket[i]),
					factType: factType(bucket[i]),
					similarity: 1,
					members: members.map((fact) => ({
						id: fact?.id,
						text: factText(fact),
						tags: Array.isArray(fact?.tags) ? fact.tags : [],
						factType: factType(fact),
						createdAt: fact?.created_at ?? fact?.stored_at ?? null,
					updatedAt: fact?.updated_at ?? null,
						context: fact?.context ?? null,
					})),
				});
			}
		}
	}

	// 跨层同文：同一句话被写进不同层（项目层 + 全局层）。
	// 这类**不自动处理**——它们语义不同，交给人判断。
	const byText = new Map();
	for (const fact of scanned) {
		const text = normalizeForCompare(factText(fact));
		if (!text) continue;
		if (!byText.has(text)) byText.set(text, []);
		byText.get(text).push({
			id: fact?.id,
			tags: Array.isArray(fact?.tags) ? fact.tags : [],
			text: factText(fact),
		});
	}
	const crossScope = [...byText.values()].filter(
		(group) =>
			group.length > 1 &&
			new Set(group.map((f) => tagSignature(f))).size > 1,
	);

	return { groups, crossScope, scanned: scanned.length };
}

/**
 * 生成清理计划：每组保留**最新**的一条，其余作废（可逆：state 可改回 valid）。
 * @param {Array} groups findDuplicateGroups 的 groups。
 */
export function planPrune(groups) {
	const keep = [];
	const invalidate = [];
	for (const group of Array.isArray(groups) ? groups : []) {
		const members = [...(group?.members ?? [])].sort((a, b) => recency(b) - recency(a));
		if (members.length === 0) continue;
		keep.push(members[0]);
		for (const member of members.slice(1)) invalidate.push(member);
	}
	return { keep, invalidate };
}

/**
 * 分层过滤：把事实集合裁到指定的一层。
 *
 * 层的定义（与 Hindsight 的标签语义一一对应）：
 *   - `global`  全局层：**无 tag**。所有项目都能看到（tag 白名单语义：无 tag 恒可见）。
 *   - `project` 本项目层：带 `project:<本项目标签>`。
 *   - `other`   其它项目层：带 tag 但不含本项目标签。
 *   - `all`     不裁剪。
 *
 * @param {Array} facts 事实列表。
 * @param {"global"|"project"|"other"|"all"} scope 层。
 * @param {string} projectLabel 本项目标签（小写）。
 * @returns {Array} 过滤后的事实。
 */
export function filterByScope(facts, scope = "all", projectLabel = "") {
	const list = Array.isArray(facts) ? facts : [];
	const projectTag = `project:${projectLabel}`;
	switch (scope) {
		case "global":
			return list.filter((fact) => (Array.isArray(fact?.tags) ? fact.tags : []).length === 0);
		case "project":
			return list.filter((fact) =>
				(Array.isArray(fact?.tags) ? fact.tags : []).includes(projectTag),
			);
		case "other":
			return list.filter((fact) => {
				const tags = Array.isArray(fact?.tags) ? fact.tags : [];
				return tags.length > 0 && !tags.includes(projectTag);
			});
		default:
			return list;
	}
}

/**
 * 分层体检：每层的条数、事实类型分布、最近更新时间。
 *
 * 用途（对应用户诉求「项目级和全局级的维护工具要封装好」）：
 *   全局层是**无 tag**的，写进去就是所有项目可见、且没有任何服务端淘汰机制；
 *   项目层有 observation 上限兜着。所以维护的第一步是**看清每层有多大、长什么样**。
 *
 * @param {Array} facts 事实列表（通常是活跃事实）。
 * @param {string} projectLabel 本项目标签（小写）。
 * @returns {{global: object, project: object, other: object, total: number}}
 */
export function describeLayers(facts, projectLabel = "") {
	const list = Array.isArray(facts) ? facts : [];
	const projectTag = `project:${projectLabel}`;
	const buckets = { global: [], project: [], other: [] };
	for (const fact of list) {
		const tags = Array.isArray(fact?.tags) ? fact.tags : [];
		if (tags.length === 0) buckets.global.push(fact);
		else if (tags.includes(projectTag)) buckets.project.push(fact);
		else buckets.other.push(fact);
	}
	const describe = (items) => {
		const byType = {};
		let latest = null;
		for (const fact of items) {
			const type = factType(fact);
			byType[type] = (byType[type] ?? 0) + 1;
			const at = fact?.updated_at ?? fact?.created_at ?? null;
			if (at && (latest === null || String(at) > String(latest))) latest = at;
		}
		return { count: items.length, byType, latestUpdatedAt: latest };
	};
	return {
		global: describe(buckets.global),
		project: describe(buckets.project),
		other: describe(buckets.other),
		total: list.length,
	};
}

/** 供面板/工具输出的精简摘要。 */
export function summarizeGroups(groups, { limit = 5 } = {}) {
	return (Array.isArray(groups) ? groups : []).slice(0, limit).map((group) => ({
		scope: group?.scope || group?.signature || "(无标签=全局层)",
		factType: group?.factType ?? "world",
		count: group?.members?.length ?? 0,
		samples: (group?.members ?? []).slice(0, 2).map((m) => ({
			id: m?.id,
			text: String(m?.text ?? "").slice(0, 120),
		})),
	}));
}
