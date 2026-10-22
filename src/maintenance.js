/**
 * 记忆维护能力（v0.6.0）——**纯函数层**。
 *
 * 为什么单独一个文件：
 *   - 维护判定（陈旧 / 被取代 / 孤儿 observation / 空知识页 / 卡住任务）
 *     必须**可测**：服务端不一定在跑，判定逻辑就不能碰网络；
 *   - `src/client.js` 只做 I/O，`src/index.js` 只做编排，三层各司其职，
 *     改判定不用起服务。
 *
 * 🔴 铁律：**畸形输入绝不抛异常**。
 *    维护动作是"收拾残局"的路径，事实来自服务端、可能缺字段、可能类型不对。
 *    这里任何一次 `throw` 都会让整轮工具调用失败 ⇒ 统一返回 [] / null / {}。
 *
 * 🔴 零 import：与 hygiene.js / pages.js 的纯函数层保持一致，
 *    也保证本文件能以 file:// URL 直接被加载（插件的加载形态要求）。
 */

/** 一天（毫秒）。 */
const DAY_MS = 86_400_000;

/** 一分钟（毫秒）。 */
const MINUTE_MS = 60_000;

/**
 * 破坏性动作：这些动作必须显式 confirm=true 才落手。
 * 语义对照：事实层只有软退役（state=invalidated，服务端可改回 valid ⇒ 可逆），
 * 知识页与精神模型的删除不可逆 ⇒ 一律要人点头。
 */
const CONFIRM_ACTIONS = new Set([
	"retract",
	"restore",
	"correct",
	"supersede",
	"delete",
	"clear",
]);

/** 必须写 reason 的动作：理由会进服务端留痕字段（reason / invalidation_reason）。 */
const REASON_ACTIONS = new Set(["retract", "correct", "supersede"]);

/** 空知识页的占位文案（服务端正文还没合成完时的返回值）。 */
const EMPTY_PAGE_MARKERS = new Set(["nocontentyet"]);

/** 可能承载"知识页正文"的字段名（按优先级取第一个非空）。 */
const PAGE_BODY_FIELDS = ["body", "markdown", "content", "text", "snippet"];

/**
 * 时间戳 → 毫秒。解析不了就返回 null（**不猜**）。
 * @param {unknown} value
 * @returns {number|null}
 */
function toTime(value) {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	const parsed = Date.parse(String(value));
	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 取事实正文（服务端字段是 text；容错 content）。
 * @param {unknown} fact
 * @returns {string}
 */
function factText(fact) {
	if (!fact || typeof fact !== "object") return "";
	return String(fact.text ?? fact.content ?? "");
}

/**
 * 取事实类型（服务端字段是 fact_type；容错 memory_type / type）。
 * @param {unknown} fact
 * @returns {string} 小写类型，缺失时按 world 处理。
 */
function factType(fact) {
	if (!fact || typeof fact !== "object") return "world";
	const raw = fact.fact_type ?? fact.memory_type ?? fact.type ?? "world";
	const value = String(raw).trim().toLowerCase();
	return value || "world";
}

/**
 * 取事实标签（数组）。
 * @param {unknown} fact
 * @returns {string[]}
 */
function factTags(fact) {
	if (!fact || typeof fact !== "object") return [];
	return Array.isArray(fact.tags) ? fact.tags.map((tag) => String(tag)).filter(Boolean) : [];
}

/**
 * 文本归一化：转小写，只保留 0-9 / a-z / CJK。
 *
 * 🔴 为什么不用 hygiene.js 的 normalizeForCompare：
 *    maintenance.js 必须零 import（纯函数层独立可测），
 *    所以这里自带一份口径一致的归一化。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeText(text) {
	return String(text ?? "")
		.toLowerCase()
		.replace(/[^0-9a-z\u3400-\u4dbf\u4e00-\u9fff]/g, "");
}

/**
 * 分词：拉丁词 + CJK 二元组（与 hygiene.js 同口径）。
 * @param {unknown} text
 * @returns {string[]}
 */
function tokenize(text) {
	const normalized = String(text ?? "").toLowerCase();
	const tokens = [];
	tokens.push(...(normalized.match(/[a-z0-9]+/g) ?? []));
	for (const run of normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? []) {
		if (run.length === 1) {
			tokens.push(run);
			continue;
		}
		for (let i = 0; i < run.length - 1; i += 1) {
			tokens.push(run.slice(i, i + 2));
		}
	}
	return tokens;
}

/**
 * Jaccard 相似度（0-1）。
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
function jaccard(a, b) {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) {
		if (b.has(token)) shared += 1;
	}
	return shared / (a.size + b.size - shared);
}

/**
 * 事实是否处于活跃状态。
 *
 * 服务端语义：state=invalidated 是软退役（可逆），缺省即 valid。
 *
 * @param {unknown} fact
 * @returns {boolean}
 */
export function isActiveFact(fact) {
	if (!fact || typeof fact !== "object") return false;
	const state = fact.state;
	if (state === undefined || state === null || state === "") return true;
	return String(state).trim().toLowerCase() === "valid";
}

/**
 * 事实的时间戳：updated_at ?? created_at ?? null。
 *
 * 🔴 服务端事实没有 created_at，updated_at 恒在；
 *    没有时间戳的事实**不判定为陈旧**（宁可漏判，也不要误伤）。
 *
 * @param {unknown} fact
 * @returns {unknown}
 */
export function factTimestamp(fact) {
	if (!fact || typeof fact !== "object") return null;
	const value = fact.updated_at ?? fact.created_at ?? null;
	return value === undefined ? null : value;
}

/**
 * 陈旧候选：超过 days 天没更新的活跃事实。
 *
 * 边界口径：age >= days * 一天 ⇒ 算陈旧（闭区间）。
 * observation 默认排除（它是派生层，不该被人手动退役）。
 *
 * @param {unknown[]} facts 事实列表。
 * @param {{now?: number, days?: number, includeObservations?: boolean}} [options]
 * @returns {Array<{id: string, factType: string, text: string, tags: string[], timestamp: unknown, ageDays: number}>}
 */
export function staleCandidates(
	facts,
	{ now = Date.now(), days = 180, includeObservations = false } = {},
) {
	const list = Array.isArray(facts) ? facts : [];
	const nowMs = toTime(now) ?? Date.now();
	const daysValue = Number(days);
	const span = Number.isFinite(daysValue) && daysValue > 0 ? daysValue : 180;
	const cutoff = nowMs - span * DAY_MS;
	const out = [];
	for (const fact of list) {
		if (!fact || typeof fact !== "object") continue;
		if (!isActiveFact(fact)) continue;
		if (!includeObservations && factType(fact) === "observation") continue;
		const stamp = toTime(factTimestamp(fact));
		if (stamp === null) continue;
		if (stamp > cutoff) continue;
		out.push({
			id: String(fact.id ?? ""),
			factType: factType(fact),
			text: factText(fact),
			tags: factTags(fact),
			timestamp: factTimestamp(fact),
			ageDays: Math.round(((nowMs - stamp) / DAY_MS) * 10) / 10,
		});
	}
	return out;
}

/**
 * 孤儿 observation：来源事实已作废、已消失，或来源本身也是 observation。
 *
 * 服务端语义：observation 由 world/experience 事实 consolidate 而来，
 * 来源没了 ⇒ 这条 observation 已经是"悬空结论"。
 *
 * @param {unknown[]} facts
 * @returns {Array<{id: string, factType: string, text: string, sourceMemoryIds: string[], missingSourceIds: string[]}>}
 */
export function orphanObservations(facts) {
	const list = Array.isArray(facts) ? facts : [];
	const byId = new Map();
	for (const fact of list) {
		if (!fact || typeof fact !== "object") continue;
		const id = String(fact.id ?? "");
		if (id) byId.set(id, fact);
	}
	const out = [];
	for (const fact of list) {
		if (!fact || typeof fact !== "object") continue;
		if (factType(fact) !== "observation") continue;
		const sources = Array.isArray(fact.source_memory_ids)
			? fact.source_memory_ids.map((id) => String(id)).filter(Boolean)
			: [];
		if (sources.length === 0) continue;
		const missing = [];
		for (const sourceId of sources) {
			const source = byId.get(sourceId);
			if (!source || !isActiveFact(source) || factType(source) === "observation") {
				missing.push(sourceId);
			}
		}
		if (missing.length === 0) continue;
		out.push({
			id: String(fact.id ?? ""),
			factType: factType(fact),
			text: factText(fact),
			sourceMemoryIds: sources,
			missingSourceIds: missing,
		});
	}
	return out;
}

/**
 * 被取代候选：活跃的 world/experience 事实，正文已被**另一条更新的活跃事实包含**。
 *
 * 口径：归一化后严格包含（容器更长）且容器不早于被包含者；
 * 两边都没有时间戳时，只按"内容更长"判定。
 *
 * @param {unknown[]} facts
 * @returns {Array<{id: string, factType: string, text: string, supersededBy: string, timestamp: unknown}>}
 */
export function supersededCandidates(facts) {
	const list = (Array.isArray(facts) ? facts : []).filter(
		(fact) =>
			fact &&
			typeof fact === "object" &&
			isActiveFact(fact) &&
			factType(fact) !== "observation",
	);
	const out = [];
	for (const fact of list) {
		const own = normalizeText(factText(fact));
		if (!own) continue;
		let container = null;
		let containerTime = null;
		for (const other of list) {
			if (other === fact) continue;
			const text = normalizeText(factText(other));
			if (!text || text === own) continue;
			if (!text.includes(own)) continue;
			const otherTime = toTime(factTimestamp(other));
			const ownTime = toTime(factTimestamp(fact));
			if (otherTime !== null && ownTime !== null && otherTime < ownTime) continue;
			if (
				container === null ||
				(otherTime !== null && (containerTime === null || otherTime > containerTime))
			) {
				container = other;
				containerTime = otherTime;
			}
		}
		if (!container) continue;
		out.push({
			id: String(fact.id ?? ""),
			factType: factType(fact),
			text: factText(fact),
			supersededBy: String(container.id ?? ""),
			timestamp: factTimestamp(fact),
		});
	}
	return out;
}

/**
 * 取知识页正文（树节点没有正文，只有页详情/搜索结果才有）。
 * @param {unknown} page
 * @returns {string}
 */
function pageBody(page) {
	if (!page || typeof page !== "object") return "";
	for (const field of PAGE_BODY_FIELDS) {
		const value = page[field];
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

/**
 * 空知识页：正文为空，或只剩占位文案（"No content yet."）。
 * @param {unknown[]} pages
 * @returns {Array<{id: string, name: string, text: string}>}
 */
export function emptyPages(pages) {
	const list = Array.isArray(pages) ? pages : [];
	const out = [];
	for (const page of list) {
		if (!page || typeof page !== "object") continue;
		// 知识页的**树节点没有正文字段** ⇒ 不能当成空页（那是"没读到"，不是"空的"）。
		if (!PAGE_BODY_FIELDS.some((field) => field in page)) continue;
		const body = pageBody(page);
		const normalized = normalizeText(body);
		if (normalized !== "" && !EMPTY_PAGE_MARKERS.has(normalized)) continue;
		out.push({
			id: String(page.id ?? page.page_id ?? ""),
			name: String(page.name ?? page.title ?? ""),
			text: body,
		});
	}
	return out;
}

/**
 * 卡住的任务：状态还是 pending / processing，且创建超过 minutes 分钟。
 *
 * 🔴 服务端失败任务**不会自动重试**（retry_count=0、next_retry_at=null），
 *    所以卡住的任务必须被人看见。
 *
 * @param {unknown[]} operations
 * @param {{now?: number, minutes?: number}} [options]
 * @returns {Array<{id: string, status: string, taskType: string, ageMinutes: number, createdAt: unknown}>}
 */
export function stuckOperations(operations, { now = Date.now(), minutes = 30 } = {}) {
	const list = Array.isArray(operations) ? operations : [];
	const nowMs = toTime(now) ?? Date.now();
	const minutesValue = Number(minutes);
	const span = Number.isFinite(minutesValue) && minutesValue > 0 ? minutesValue : 30;
	const cutoff = nowMs - span * MINUTE_MS;
	const out = [];
	for (const operation of list) {
		if (!operation || typeof operation !== "object") continue;
		const status = String(operation.status ?? "").trim().toLowerCase();
		if (status !== "pending" && status !== "processing") continue;
		const created = toTime(operation.created_at ?? operation.updated_at ?? null);
		if (created === null) continue;
		if (created > cutoff) continue;
		out.push({
			id: String(operation.operation_id ?? operation.id ?? ""),
			status,
			taskType: String(operation.task_type ?? operation.operation_type ?? "unknown"),
			ageMinutes: Math.round(((nowMs - created) / MINUTE_MS) * 10) / 10,
			createdAt: operation.created_at ?? null,
		});
	}
	return out;
}

/**
 * 近重复分组（Jaccard 相似度，与 hygiene.js 同口径）。
 * @param {unknown[]} facts
 * @param {number} threshold
 * @returns {Array<{ids: string[], items: Array<object>}>}
 */
function nearDuplicateGroups(facts, threshold) {
	const list = (Array.isArray(facts) ? facts : [])
		.filter((fact) => fact && typeof fact === "object" && isActiveFact(fact))
		.slice(0, 500);
	const tokens = list.map((fact) => new Set(tokenize(factText(fact))));
	const used = new Set();
	const groups = [];
	for (let i = 0; i < list.length; i += 1) {
		if (used.has(i)) continue;
		const members = [i];
		for (let j = i + 1; j < list.length; j += 1) {
			if (used.has(j)) continue;
			if (jaccard(tokens[i], tokens[j]) < threshold) continue;
			members.push(j);
			used.add(j);
		}
		if (members.length < 2) continue;
		used.add(i);
		groups.push({
			ids: members.map((index) => String(list[index]?.id ?? "")),
			items: members.map((index) => ({
				id: String(list[index]?.id ?? ""),
				factType: factType(list[index]),
				text: factText(list[index]),
				tags: factTags(list[index]),
			})),
		});
	}
	return groups;
}

/**
 * 维护审计计划：把"哪里该修"一次性算清楚（**只读**）。
 *
 * @param {{facts?: unknown[], pages?: unknown[], operations?: unknown[], now?: number, staleDays?: number, stuckMinutes?: number, threshold?: number}} [input]
 * @returns {{counts: object, groups: Array<{kind: string, items: Array<object>, reason: string}>}}
 */
export function auditPlan({
	facts = [],
	pages = [],
	operations = [],
	now = Date.now(),
	staleDays = 180,
	stuckMinutes = 30,
	threshold = 0.9,
} = {}) {
	const factList = Array.isArray(facts) ? facts : [];
	const pageList = Array.isArray(pages) ? pages : [];
	const operationList = Array.isArray(operations) ? operations : [];
	const nowMs = toTime(now) ?? Date.now();
	const stale = staleCandidates(factList, { now: nowMs, days: staleDays });
	const orphans = orphanObservations(factList);
	const superseded = supersededCandidates(factList);
	const empties = emptyPages(pageList);
	const stuck = stuckOperations(operationList, { now: nowMs, minutes: stuckMinutes });
	const duplicateGroups = nearDuplicateGroups(factList, threshold);
	const duplicateItems = duplicateGroups.map((group) => ({
		ids: group.ids,
		items: group.items,
	}));
	const groups = [
		{
			kind: "stale",
			items: stale,
			reason: `超过 ${staleDays} 天没有更新（updated_at）`,
		},
		{
			kind: "orphan-observation",
			items: orphans,
			reason: "observation 的来源事实已作废或已消失",
		},
		{
			kind: "superseded",
			items: superseded,
			reason: "正文已被更新的事实包含",
		},
		{
			kind: "duplicate",
			items: duplicateItems,
			reason: `近重复（相似度 ≥ ${threshold}）`,
		},
		{
			kind: "empty-page",
			items: empties,
			reason: "知识页正文为空或只剩占位文案",
		},
		{
			kind: "stuck-operation",
			items: stuck,
			reason: `超过 ${stuckMinutes} 分钟仍是 pending/processing`,
		},
	];
	const duplicateFactCount = duplicateItems.reduce((sum, group) => sum + group.items.length, 0);
	return {
		counts: {
			facts: factList.length,
			pages: pageList.length,
			operations: operationList.length,
			stale: stale.length,
			orphanObservations: orphans.length,
			superseded: superseded.length,
			duplicates: duplicateGroups.length,
			duplicateFacts: duplicateFactCount,
			emptyPages: empties.length,
			stuckOperations: stuck.length,
			actionable:
				stale.length +
				orphans.length +
				superseded.length +
				empties.length +
				stuck.length +
				duplicateFactCount,
		},
		groups,
	};
}

/**
 * 这个动作要不要显式确认（confirm=true）。
 *
 * @param {unknown} action
 * @returns {boolean}
 */
export function requiresConfirm(action) {
	if (typeof action !== "string") return false;
	return CONFIRM_ACTIONS.has(action.trim().toLowerCase());
}

/**
 * 这个动作要不要写理由（reason）。
 *
 * @param {unknown} action
 * @returns {boolean}
 */
export function requiresReason(action) {
	if (typeof action !== "string") return false;
	return REASON_ACTIONS.has(action.trim().toLowerCase());
}

/**
 * 纠正一条事实的 PATCH 体（PATCH /memories/{id}）。
 *
 * 服务端语义：改 text 会重新 embed，并**丢弃派生 observation**。
 *
 * @param {{factId?: string, text?: string, reason?: string}} input
 * @returns {{text: string, reason: string}|null} 缺正文时返回 null。
 */
export function correctionPatch({ factId, text, reason } = {}) {
	const id = String(factId ?? "").trim();
	const body = String(text ?? "").trim();
	if (!id || !body) return null;
	return { text: body, reason: String(reason ?? "").trim() };
}

/**
 * 作废一条事实的 PATCH 体（服务端可逆：state 改回 valid 即恢复）。
 *
 * @param {{factId?: string, reason?: string}} input
 * @returns {{state: string, reason: string}|null}
 */
export function supersedePatch({ factId, reason } = {}) {
	const id = String(factId ?? "").trim();
	if (!id) return null;
	return { state: "invalidated", reason: String(reason ?? "").trim() };
}

/**
 * 恢复一条事实的 PATCH 体。
 *
 * @param {{factId?: string}} input
 * @returns {{state: string}|null}
 */
export function restorePatch({ factId } = {}) {
	const id = String(factId ?? "").trim();
	if (!id) return null;
	return { state: "valid" };
}

/**
 * 写操作闸门：返回 null 表示放行；否则返回错误信封。
 *
 * 规则：
 *   - 破坏性动作（retract / correct / supersede / prune 等）必须显式 confirm=true；
 *   - 改写与退役类动作必须写 reason，否则服务端留不下痕迹；
 *   - 只读动作（audit / preview / layers …）永远放行。
 *
 * @param {{action?: string, confirm?: unknown, reason?: unknown, requireConfirm?: boolean}} input
 * @returns {{error: string, message: string}|null}
 */
export function guardAction({ action, confirm, reason, requireConfirm = true } = {}) {
	const name = String(action ?? "").trim().toLowerCase();
	if (!name) return null;
	if (requireConfirm !== false && requiresConfirm(name) && confirm !== true) {
		return {
			ok: false,
			error: "confirm_required",
			message: `${name} 是破坏性动作，必须显式传 confirm=true（否则只出计划不落手）`,
		};
	}
	if (requiresReason(name) && !String(reason ?? "").trim()) {
		return {
			ok: false,
			error: "reason_required",
			message: `${name} 必须写 reason（会写进服务端留痕）`,
		};
	}
	return null;
}
