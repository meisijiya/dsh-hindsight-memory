/**
 * 记忆维护层（v0.6.0）的契约测试：纯函数、零 I/O ⇒ 不需要服务端也能跑。
 *
 * 为什么测这个：v0.6.0 给每个记忆能力都开了「可改、可退役、可纠正」的入口，
 * 但落手都绑着两条护栏 —— 破坏性动作必须显式 confirm=true，
 * 撤回 / 纠正 / 替换必须写 reason（会进服务端留痕字段）。
 * 护栏一旦破例，误伤一条长期记忆的代价就是「认知错位」，所以逐条钉死。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	auditPlan,
	correctionPatch,
	describeSources,
	emptyPages,
	factTimestamp,
	guardAction,
	isActiveFact,
	isObservationCurationError,
	orphanObservations,
	requiresConfirm,
	requiresReason,
	restorePatch,
	staleCandidates,
	stuckOperations,
	supersedePatch,
	supersededCandidates,
} from "../src/maintenance.js";
import { DEFAULTS, normalizeConfig } from "../src/config.js";
import { FIELD_DOCS } from "../src/schema.js";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-06-01T00:00:00.000Z");

/** 造一条事实（默认：活跃、world 类型、10 天前更新）。 */
function fact(id, text, extra = {}) {
	return {
		id,
		text,
		fact_type: "world",
		state: "valid",
		updated_at: new Date(NOW - 10 * DAY_MS).toISOString(),
		...extra,
	};
}

test("isActiveFact：state 缺省当 valid，invalidated 不算活跃", () => {
	assert.equal(isActiveFact({ state: "valid" }), true);
	assert.equal(isActiveFact({}), true);
	assert.equal(isActiveFact({ state: "" }), true);
	assert.equal(isActiveFact({ state: "invalidated" }), false);
	assert.equal(isActiveFact(null), false);
});

test("factTimestamp：updated_at 优先，其次 created_at，都没有就是 null", () => {
	assert.equal(factTimestamp({ updated_at: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00.000Z");
	assert.equal(factTimestamp({ created_at: "2026-02-01T00:00:00.000Z" }), "2026-02-01T00:00:00.000Z");
	assert.equal(
		factTimestamp({ updated_at: "2026-03-01T00:00:00.000Z", created_at: "2026-02-01T00:00:00.000Z" }),
		"2026-03-01T00:00:00.000Z",
	);
	assert.equal(factTimestamp({}), null);
});

test("staleCandidates：正好 180 天算陈旧（边界含），observation 默认排除", () => {
	const facts = [
		fact("old", "很久没动的事实", { updated_at: new Date(NOW - 180 * DAY_MS).toISOString() }),
		fact("fresh", "刚写的事实", { updated_at: new Date(NOW - 179 * DAY_MS).toISOString() }),
		fact("obs", "一条老观察", {
			fact_type: "observation",
			updated_at: new Date(NOW - 400 * DAY_MS).toISOString(),
		}),
		fact("noTime", "没有时间戳的事实", { updated_at: undefined, created_at: undefined }),
	];
	const stale = staleCandidates(facts, { now: NOW, days: 180 });
	assert.deepEqual(stale.map((item) => item.id), ["old"]);
	assert.equal(stale[0].ageDays, 180);
	const withObs = staleCandidates(facts, { now: NOW, days: 180, includeObservations: true });
	assert.deepEqual(withObs.map((item) => item.id).sort(), ["obs", "old"]);
});

test("orphanObservations：来源作废或消失的观察算孤儿，正常来源不算", () => {
	const facts = [
		fact("w1", "活着的世界事实"),
		fact("w2", "已作废的世界事实", { state: "invalidated" }),
		fact("o1", "正常观察", { fact_type: "observation", source_memory_ids: ["w1"] }),
		fact("o2", "指向作废来源的观察", { fact_type: "observation", source_memory_ids: ["w2"] }),
		fact("o3", "指向消失来源的观察", { fact_type: "observation", source_memory_ids: ["ghost"] }),
	];
	const orphans = orphanObservations(facts);
	assert.deepEqual(orphans.map((item) => item.id).sort(), ["o2", "o3"]);
	assert.deepEqual(orphans.find((item) => item.id === "o3").missingSourceIds, ["ghost"]);
});

test("supersededCandidates：被更新的事实包含的旧事实算被取代", () => {
	const facts = [
		fact("old", "Hindsight 默认单 bank", { updated_at: new Date(NOW - 200 * DAY_MS).toISOString() }),
		fact("new", "Hindsight 默认单 bank，按 project 标签分栏", {
			updated_at: new Date(NOW - 5 * DAY_MS).toISOString(),
		}),
		fact("other", "完全无关的一条事实", { updated_at: new Date(NOW - 5 * DAY_MS).toISOString() }),
	];
	const superseded = supersededCandidates(facts);
	assert.deepEqual(superseded.map((item) => item.id), ["old"]);
	assert.equal(superseded[0].supersededBy, "new");
});

test("emptyPages：正文为空或只剩占位文案算空页，树节点不算", () => {
	const pages = [
		{ id: "p1", name: "空页", body: "" },
		{ id: "p2", name: "占位页", markdown: "No content yet." },
		{ id: "p3", name: "正常页", body: "真正的正文" },
		{ id: "p4", name: "树节点", kind: "page" },
	];
	const empty = emptyPages(pages);
	assert.deepEqual(empty.map((item) => item.id), ["p1", "p2"]);
});

test("stuckOperations：pending/processing 超过阈值算卡住", () => {
	const operations = [
		{ id: "o1", status: "pending", created_at: new Date(NOW - 31 * 60_000).toISOString() },
		{ id: "o2", status: "processing", created_at: new Date(NOW - 45 * 60_000).toISOString() },
		{ id: "o3", status: "pending", created_at: new Date(NOW - 5 * 60_000).toISOString() },
		{ id: "o4", status: "completed", created_at: new Date(NOW - 90 * 60_000).toISOString() },
	];
	const stuck = stuckOperations(operations, { now: NOW, minutes: 30 });
	assert.deepEqual(stuck.map((item) => item.id).sort(), ["o1", "o2"]);
	assert.equal(stuck.find((item) => item.id === "o1").ageMinutes, 31);
});

test("auditPlan：分组与计数对得上（只读，不动手）", () => {
	const facts = [
		fact("stale1", "很久以前的事实", { updated_at: new Date(NOW - 400 * DAY_MS).toISOString() }),
		fact("obs1", "孤儿观察", { fact_type: "observation", source_memory_ids: ["ghost"] }),
		fact("dup1", "重复内容一"),
		fact("dup2", "重复内容一"),
	];
	const plan = auditPlan({
		facts,
		pages: [{ id: "p1", name: "空页", body: "" }],
		operations: [{ id: "o1", status: "processing", created_at: new Date(NOW - 60 * 60_000).toISOString() }],
		now: NOW,
		staleDays: 180,
		stuckMinutes: 30,
		threshold: 0.9,
	});
	assert.equal(plan.counts.facts, 4);
	assert.equal(plan.counts.pages, 1);
	assert.equal(plan.counts.operations, 1);
	assert.equal(plan.counts.stale, 1);
	assert.equal(plan.counts.orphanObservations, 1);
	assert.equal(plan.counts.superseded, 0);
	assert.equal(plan.counts.duplicates, 1);
	assert.equal(plan.counts.duplicateFacts, 2);
	assert.equal(plan.counts.emptyPages, 1);
	assert.equal(plan.counts.stuckOperations, 1);
	assert.equal(plan.counts.actionable, 6);
	const kinds = plan.groups.map((group) => group.kind);
	for (const kind of ["stale", "orphan-observation", "superseded", "duplicate", "empty-page", "stuck-operation"]) {
		assert.ok(kinds.includes(kind), `auditPlan 缺少分组 ${kind}`);
	}
});

test("requiresConfirm / requiresReason：破坏性动作矩阵", () => {
	for (const action of ["retract", "restore", "correct", "supersede", "delete", "clear"]) {
		assert.equal(requiresConfirm(action), true, `${action} 应当要 confirm`);
	}
	for (const action of ["audit", "preview", "list", "update", "read"]) {
		assert.equal(requiresConfirm(action), false, `${action} 不该要 confirm`);
	}
	for (const action of ["retract", "correct", "supersede"]) {
		assert.equal(requiresReason(action), true, `${action} 应当要 reason`);
	}
	assert.equal(requiresReason("restore"), false);
	assert.equal(requiresReason("delete"), false);
});

test("correctionPatch / supersedePatch / restorePatch：PATCH 体形状固定", () => {
	assert.deepEqual(correctionPatch({ factId: "f1", text: "  改正后的正文  ", reason: " 与服务端不符 " }), {
		text: "改正后的正文",
		reason: "与服务端不符",
	});
	assert.equal(correctionPatch({ factId: "f1", text: "  " }), null);
	assert.equal(correctionPatch({ text: "没有 id" }), null);
	assert.deepEqual(supersedePatch({ factId: "f1", reason: "已被新事实取代" }), {
		state: "invalidated",
		reason: "已被新事实取代",
	});
	assert.equal(supersedePatch({}), null);
	assert.deepEqual(restorePatch({ factId: "f1" }), { state: "valid" });
});

test("护栏：破坏性动作没有 confirm 就被拦下（一个服务端请求都不该发）", () => {
	const denied = guardAction({ action: "retract", reason: "写错了" });
	assert.equal(denied.ok, false);
	assert.equal(denied.error, "confirm_required");
	assert.equal(guardAction({ action: "delete" }).error, "confirm_required");
	assert.equal(guardAction({ action: "clear" }).error, "confirm_required");
	assert.equal(guardAction({ action: "audit" }), null);
});

test("护栏：撤回 / 纠正 / 替换缺 reason 就被拦下", () => {
	const denied = guardAction({ action: "retract", confirm: true });
	assert.equal(denied.ok, false);
	assert.equal(denied.error, "reason_required");
	assert.equal(guardAction({ action: "correct", confirm: true, reason: "   " }).error, "reason_required");
	assert.equal(guardAction({ action: "supersede", confirm: true, reason: "新事实已写入" }), null);
	assert.equal(guardAction({ action: "restore", confirm: true }), null);
});

test("畸形输入不抛异常（维护路径容错优先）", () => {
	assert.deepEqual(staleCandidates(null, { now: NOW }), []);
	assert.deepEqual(orphanObservations(undefined), []);
	assert.deepEqual(supersededCandidates("不是数组"), []);
	assert.deepEqual(emptyPages(42), []);
	assert.deepEqual(stuckOperations(null, { now: NOW }), []);
	const plan = auditPlan();
	assert.equal(plan.counts.facts, 0);
	assert.deepEqual(plan.groups.find((group) => group.kind === "stale").items, []);
	assert.equal(factTimestamp(null), null);
	assert.equal(isActiveFact(undefined), false);
});

test("维护配置字段在 config / schema / ui 三处一致", () => {
	const keys = [
		"maintenanceStaleDays",
		"maintenanceStuckMinutes",
		"maintenanceRequireConfirm",
		"maintenanceTimeoutMs",
	];
	for (const key of keys) {
		assert.ok(key in DEFAULTS, `DEFAULTS 缺少 ${key}`);
		assert.ok(key in FIELD_DOCS, `FIELD_DOCS 缺少 ${key}`);
	}
	assert.equal(Object.keys(DEFAULTS).filter((key) => key.startsWith("maintenance")).length, 4);
	const config = normalizeConfig({});
	assert.equal(config.maintenanceStaleDays, 180);
	assert.equal(config.maintenanceStuckMinutes, 30);
	assert.equal(config.maintenanceRequireConfirm, true);
	assert.equal(normalizeConfig({ maintenanceStaleDays: "30" }).maintenanceStaleDays, 30);
	assert.equal(normalizeConfig({ maintenanceStaleDays: "不是数字" }).maintenanceStaleDays, 180);
	assert.equal(normalizeConfig({ maintenanceStaleDays: 0 }).maintenanceStaleDays, 1);
	assert.equal(normalizeConfig({ maintenanceRequireConfirm: false }).maintenanceRequireConfirm, false);
	const ui = readFileSync(new URL("../src/ui-client.js", import.meta.url), "utf8");
	for (const key of keys) {
		assert.ok(ui.includes(key), `ui-client 缺少字段 ${key}`);
	}
	assert.ok(ui.includes("维护"), "ui-client 缺少「维护」分组");
});

test("工具级护栏：破坏性动作缺 confirm / 缺 reason ⇒ 不碰服务端（离线可验）", async () => {
	const mod = await import("../src/index.js");
	const registered = new Map();
	const ctx = {
		tools: { register: (tool) => registered.set(tool.name, tool) },
		systemPrompt: { section: () => () => {} },
		logger: { warn: () => {} },
		on: () => {},
		effect: () => {},
		workingDirectory: { get: () => process.cwd() },
	};
	await mod.apply(ctx, {});
	assert.equal(registered.size, 9, "工具数量必须仍是 9（维护并入既有工具，不新增工具）");
	const hygiene = registered.get("memory_hygiene");
	const pages = registered.get("memory_pages");
	const models = registered.get("memory_mental_models");
	assert.ok(hygiene && pages && models, "维护动作所在的三个工具必须仍然注册");

	const exec = { agent: { id: "agent-guard", session: { header: { cwd: process.cwd() } } } };
	const call = async (tool, args) => JSON.parse((await tool.execute(args, exec)).content[0].text);

	const noConfirm = await call(hygiene, { action: "retract", factId: "f1" });
	assert.equal(noConfirm.ok, false);
	assert.equal(noConfirm.error, "confirm_required");

	const noReason = await call(hygiene, { action: "retract", factId: "f1", confirm: true });
	assert.equal(noReason.ok, false);
	assert.equal(noReason.error, "reason_required");

	assert.equal((await call(pages, { action: "delete", pageId: "p1" })).error, "confirm_required");
	assert.equal((await call(models, { action: "delete", id: "m1" })).error, "confirm_required");
	assert.equal((await call(models, { action: "clear", id: "m1" })).error, "confirm_required");
});

test("observation 不可策展的报错能被识别，并指出该改哪几条源事实", () => {
	const serverMessage =
		"Hindsight HTTP 400: {\"detail\":\"Memory 'o1' is a observation; only world/experience facts can be curated. Observations are derived and regenerate from their sources.\"}";
	assert.equal(isObservationCurationError(serverMessage), true);
	assert.equal(isObservationCurationError("Hindsight HTTP 404: not found"), false);
	assert.equal(isObservationCurationError(undefined), false);

	const facts = [
		fact("s1", "源事实一", { tags: ["project:demo"] }),
		fact("s2", "源事实二", { tags: [] }),
		fact("x1", "无关事实", { tags: [] }),
	];
	const described = describeSources(facts, ["s1", "s2", "missing"], { textLength: 5 });
	assert.deepEqual(
		described.map((entry) => entry.id),
		["s1", "s2"],
		"只应列出真实存在的源事实",
	);
	assert.equal(described[0].text, "源事实一");
	assert.deepEqual(described[1].tags, []);
	assert.deepEqual(describeSources(facts, []), [], "没有源事实时返回空数组");

	// 回归：调用方直接传服务端分页信封（listFacts 返回 {items:[...]}）时不能炸。
	// 曾因此让 observation_not_curatable 分支在活体里退化成 "(facts ?? []) is not iterable"。
	const envelope = { items: facts, total: facts.length, limit: 500, offset: 0 };
	assert.deepEqual(
		describeSources(envelope, ["s1"]).map((entry) => entry.id),
		["s1"],
		"分页信封也要能取出源事实",
	);
	assert.deepEqual(describeSources({ memories: facts }, ["s2"]).map((entry) => entry.id), ["s2"]);
	assert.deepEqual(describeSources(null, ["s1"]), [], "没有事实列表时返回空数组");
});
