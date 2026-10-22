/**
 * 记忆看板（v0.7.0）——把 Hindsight 的原始列表压成一份**可展示快照**。
 *
 * 为什么单独一个文件：
 *   - 面板的数据形状必须**可测**：服务端不一定在跑，形状逻辑就不能碰网络；
 *   - `src/client.js` 只做 I/O，`src/index.js` 只做编排，这里只做整形，
 *     改展示字段不用改 RPC 通道，也不用起服务。
 *
 * 🔴 铁律：畸形输入绝不抛异常。
 *    面板是「看」的路径，数据来自服务端、可能缺字段、可能类型不对；
 *    这里任何一次 throw 都会让整块看板变成空白 ⇒ 统一返回空集合 / 0。
 */

import { describeLayers, findDuplicateGroups } from "./hygiene.js";
import { auditPlan } from "./maintenance.js";

/** 宿主 RPC 通道名（通道名必须匹配 /^\/[A-Za-z0-9._~-]+$/）。 */
export const PANEL_RPC_CHANNEL = "/dsh-hindsight-memory";

/** 面板支持的端点。 */
export const PANEL_ENDPOINTS = Object.freeze([
	"overview",
	"layers",
	"audit",
	"operations",
	"models",
	"pages",
	"config",
]);

/** 正文截断长度（看板只给摘要，不整篇搬）。 */
const TEXT_LIMIT = 160;

/**
 * 允许出现在看板里的配置字段（白名单）。
 *
 * 不含任何凭证类字段；也不含 panel 内部用的超时/阈值细节之外的实现项。
 */
const PUBLIC_CONFIG_KEYS = Object.freeze([
	"enabled",
	"inject",
	"writeEnabled",
	"apiUrl",
	"bankId",
	"bankIdPrefix",
	"scoping",
	"types",
	"budget",
	"autoRecall",
	"autoRetain",
	"retainEveryNTurns",
	"knowledgePages",
	"mentalModels",
	"injectMentalModels",
	"hygieneScope",
	"hygieneThreshold",
	"maintenanceStaleDays",
	"maintenanceStuckMinutes",
	"transport",
]);

/**
 * 事实列表归一化（服务端 listFacts 返回分页信封 {items,total,limit,offset}）。
 * @param {unknown} raw
 * @returns {Array}
 */
export function normalizeFactList(raw) {
	if (Array.isArray(raw)) return raw;
	const items = raw?.items ?? raw?.memories ?? raw?.facts ?? [];
	return Array.isArray(items) ? items : [];
}

/**
 * 操作列表归一化（listOperations 返回 {operations,total,limit,offset}）。
 * @param {unknown} raw
 * @returns {Array}
 */
export function normalizeOperationList(raw) {
	if (Array.isArray(raw)) return raw;
	const items = raw?.operations ?? raw?.items ?? [];
	return Array.isArray(items) ? items : [];
}

/**
 * 精神模型列表归一化（listMentalModels 返回 {items,total,limit,offset}）。
 * @param {unknown} raw
 * @returns {Array}
 */
export function normalizeModelList(raw) {
	if (Array.isArray(raw)) return raw;
	const items = raw?.models ?? raw?.items ?? [];
	return Array.isArray(items) ? items : [];
}

/**
 * 知识页列表归一化。
 * @param {unknown} raw
 * @returns {Array}
 */
export function normalizePageList(raw) {
	if (Array.isArray(raw)) return raw;
	const items = raw?.pages ?? raw?.items ?? [];
	return Array.isArray(items) ? items : [];
}

/**
 * 操作概览：状态分布 + 任务类型分布 + 最近几条。
 * @param {unknown} operations
 * @returns {{total: number, byStatus: object, byTask: object, recent: Array}}
 */
export function buildOperationSummary(operations) {
	const list = normalizeOperationList(operations);
	const byStatus = {};
	const byTask = {};
	for (const operation of list) {
		const status = String(operation?.status ?? "unknown");
		byStatus[status] = (byStatus[status] ?? 0) + 1;
		const task = String(operation?.task_type ?? operation?.operation_type ?? "unknown");
		byTask[task] = (byTask[task] ?? 0) + 1;
	}
	return {
		total: list.length,
		byStatus,
		byTask,
		recent: list.slice(0, 8).map((operation) => ({
			id: operation?.id ?? null,
			taskType: operation?.task_type ?? operation?.operation_type ?? null,
			status: operation?.status ?? null,
			createdAt: operation?.created_at ?? null,
			updatedAt: operation?.updated_at ?? null,
			error: operation?.error_message ?? null,
		})),
	};
}

/**
 * 精神模型概览：名字、标签、陈旧标记、刷新失败时间。
 * @param {unknown} models
 * @returns {Array}
 */
export function buildModelSummary(models) {
	return normalizeModelList(models).map((model) => ({
		id: model?.id ?? null,
		name: model?.name ?? null,
		tags: Array.isArray(model?.tags) ? model.tags : [],
		isStale: model?.is_stale === true,
		lastRefreshFailedAt: model?.last_refresh_failed_at ?? null,
		lastRefreshedAt: model?.last_refreshed_at ?? null,
	}));
}

/**
 * 知识页概览：名字、层级标签、陈旧标记。
 * @param {unknown} pages
 * @returns {Array}
 */
export function buildPageSummary(pages) {
	return normalizePageList(pages).map((page) => ({
		id: page?.id ?? null,
		name: page?.name ?? null,
		kind: page?.kind ?? "page",
		tags: Array.isArray(page?.tags) ? page.tags : [],
		isStale: page?.is_stale === true || page?.isStale === true,
		lastRefreshFailedAt: page?.last_refresh_failed_at ?? page?.lastRefreshFailedAt ?? null,
	}));
}

/**
 * 只暴露**可公开**的配置字段给看板。
 *
 * 🔴 为什么筛：配置里可能有内部实现细节（超时、阈值、路径），
 *    但也有**不该出现在浏览器里的东西**（凭证类字段）。
 *    这里用白名单而不是黑名单 —— 新增配置默认不外泄。
 *
 * @param {object|null} config 归一化后的配置。
 * @returns {object}
 */
export function pickPublicConfig(config) {
	const source = config && typeof config === "object" ? config : {};
	const out = {};
	for (const key of PUBLIC_CONFIG_KEYS) {
		if (source[key] === undefined) continue;
		out[key] = source[key];
	}
	return out;
}

/**
 * 组装看板快照。
 *
 * @param {object} [input]
 * @param {unknown} [input.facts] 事实列表。
 * @param {unknown} [input.operations] 操作列表。
 * @param {unknown} [input.models] 精神模型列表。
 * @param {unknown} [input.pages] 知识页列表。
 * @param {object|null} [input.bank] bank 概览。
 * @param {string} [input.projectLabel] 当前项目标签（小写仓库名）。
 * @param {number} [input.now] 判定"陈旧/卡住"的基准时间（毫秒）。
 * @param {number} [input.staleDays] 陈旧阈值（天）。
 * @param {number} [input.stuckMinutes] 卡住阈值（分钟）。
 * @param {number} [input.threshold] 近重复相似度阈值。
 * @param {object|null} [input.config] 当前生效配置（只给公开字段）。
 * @returns {object}
 */
export function buildPanelSnapshot({
	facts = [],
	operations = [],
	models = [],
	pages = [],
	bank = null,
	projectLabel = "",
	now = Date.now(),
	staleDays = 180,
	stuckMinutes = 30,
	threshold = 0.9,
	config = null,
} = {}) {
	const factList = normalizeFactList(facts);
	const operationList = normalizeOperationList(operations);
	const modelList = normalizeModelList(models);
	const pageList = normalizePageList(pages);

	const layers = describeLayers(factList, projectLabel);
	const duplicates = findDuplicateGroups(factList, { threshold });
	const audit = auditPlan({
		facts: factList,
		pages: pageList,
		operations: operationList,
		now,
		staleDays,
		stuckMinutes,
		threshold,
	});

	const duplicateSamples = (duplicates?.groups ?? []).slice(0, 5).map((group) => ({
		scope: group?.scope ?? null,
		factType: group?.factType ?? null,
		texts: (group?.members ?? []).slice(0, 3).map((member) =>
			String(member?.text ?? "").slice(0, TEXT_LIMIT),
		),
	}));

	return {
		generatedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
		projectLabel: String(projectLabel ?? ""),
		bank: bank
			? {
					bankId: bank?.bankId ?? null,
					factCount: Number(bank?.factCount ?? 0),
					documentCount: Number(bank?.documentCount ?? 0),
					totalBanks: Number(bank?.totalBanks ?? 0),
					warnings: Array.isArray(bank?.warnings) ? bank.warnings : [],
				}
			: null,
		layers,
		duplicates: {
			groups: (duplicates?.groups ?? []).length,
			crossScope: Array.isArray(duplicates?.crossScope) ? duplicates.crossScope.length : 0,
			scanned: Number(duplicates?.scanned ?? 0),
			samples: duplicateSamples,
		},
		audit: {
			counts: audit?.counts ?? {},
			groups: (audit?.groups ?? []).map((group) => ({
				kind: group?.kind ?? null,
				reason: group?.reason ?? null,
				count: Array.isArray(group?.items) ? group.items.length : 0,
			})),
		},
		operations: buildOperationSummary(operationList),
		models: buildModelSummary(modelList),
		pages: buildPageSummary(pageList),
		config: config ?? null,
	};
}
