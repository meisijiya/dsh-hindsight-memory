import assert from "node:assert/strict";
import test from "node:test";

import {
	mentalModelIds,
	mentalModelSpecs,
	normalizeMentalModels,
	planEnsure,
} from "../src/mental-models.js";
import { describeLayers, filterByScope } from "../src/hygiene.js";
import { renderMentalModelMessage } from "../src/prompt.js";

const CONFIG = { scoping: "per-project", mentalModelUserMaxTokens: 600, mentalModelProjectMaxTokens: 800 };

test("per-project 作用域下 id 与 omp 完全相同（两端共用同一份模型）", () => {
	const ids = mentalModelIds(CONFIG, "随便问问");
	assert.equal(ids.user, "user-preferences");
	assert.equal(ids.conventions, "project-conventions");
	assert.equal(ids.decisions, "project-decisions");
});

test("per-project-tagged 作用域下 id 带项目 slug 后缀（与 omp 同规则）", () => {
	const ids = mentalModelIds({ ...CONFIG, scoping: "per-project-tagged" }, "blog");
	assert.equal(ids.user, "user-preferences");
	assert.equal(ids.conventions, "project-conventions-blog");
	assert.equal(ids.decisions, "project-decisions-blog");
});

test("per-project-tagged 下中文项目名按 omp 的 slug 规则退化（与 omp 一致，不额外造 id）", () => {
	const ids = mentalModelIds({ ...CONFIG, scoping: "per-project-tagged" }, "随便问问");
	// omp 的 slug 只保留 ASCII ⇒ 中文名退化成 "project"；两端必须一致地退化，
	// 否则同一 bank 里会出现两份同语义模型、把注入预算吃光。
	assert.equal(ids.conventions, "project-conventions-project");
});

test("mentalModelPrefix 仍是可选隔离层：填值就在 omp 的 id 前再加一层", () => {
	const ids = mentalModelIds({ ...CONFIG, mentalModelPrefix: "dsh" }, "blog");
	assert.equal(ids.user, "dsh-user-preferences");
	assert.equal(ids.conventions, "dsh-project-conventions");
});

test("前缀非法字符被清洗；全空时等于不加前缀", () => {
	const ids = mentalModelIds({ ...CONFIG, mentalModelPrefix: "  *** " }, "x");
	assert.equal(ids.user, "user-preferences");
});

test("三个 mental model 的规格：全局无 tag，项目层带 project 标签，触发器是 delta", () => {
	const specs = mentalModelSpecs(CONFIG, "随便问问", ["project:随便问问"]);
	assert.equal(specs.length, 3);
	assert.equal(specs[0].tags, undefined, "用户偏好是全局层，不能带 tag");
	assert.deepEqual(specs[1].tags, ["project:随便问问"]);
	assert.deepEqual(specs[2].tags, ["project:随便问问"]);
	for (const spec of specs) {
		assert.equal(spec.trigger.mode, "delta");
		assert.equal(spec.trigger.refresh_after_consolidation, true);
		assert.ok(spec.source_query.length > 20);
	}
});

test("per-project 作用域下项目模型不带 tag（bank 已隔离，与 omp 的 tags 计算一致）", () => {
	const specs = mentalModelSpecs(CONFIG, "随便问问", []);
	assert.equal(specs[0].tags, undefined);
	assert.equal(specs[1].tags, undefined);
	assert.equal(specs[2].tags, undefined);
});

test("planEnsure：缺的建、标签不符的改标签、对的不动", () => {
	const specs = mentalModelSpecs({ ...CONFIG, scoping: "per-project-tagged" }, "blog", ["project:blog"]);
	const existing = [
		{ id: specs[0].id, tags: [] },
		{ id: specs[1].id, tags: ["project:other"] },
	];
	const plan = planEnsure(existing, specs);
	assert.equal(plan.create.length, 1);
	assert.equal(plan.create[0].id, specs[2].id);
	assert.equal(plan.patch.length, 1);
	assert.equal(plan.patch[0].id, specs[1].id);
	assert.deepEqual(plan.patch[0].tags, ["project:blog"]);
	assert.equal(plan.keep.length, 1);
	assert.equal(plan.keep[0].id, specs[0].id);
});

test("normalizeMentalModels 归一化服务端返回", () => {
	const models = normalizeMentalModels([
		{ id: "a", name: "A", content: "  hello  ", tags: ["project:x"] },
		{ mental_model_id: "b", text: "world" },
		{ name: "no-id" },
	]);
	assert.equal(models.length, 2);
	assert.equal(models[0].content, "hello");
	assert.equal(models[1].id, "b");
	assert.equal(models[1].content, "world");
});

test("renderMentalModelMessage 没有正文时返回空串（不注入空块）", () => {
	assert.equal(renderMentalModelMessage([], { bankId: "shared" }), "");
	assert.equal(renderMentalModelMessage([{ id: "a", name: "A", content: "  " }], { bankId: "shared" }), "");
	const block = renderMentalModelMessage(
		[{ id: "a", name: "Project Conventions", content: "用 pnpm" }],
		{ bankId: "shared" },
	);
	assert.ok(block.includes("<mental_models"));
	assert.ok(block.includes("用 pnpm"));
});

const FACTS = [
	{ id: "g1", tags: [], fact_type: "world", updated_at: "2026-10-20" },
	{ id: "g2", tags: [], fact_type: "observation", updated_at: "2026-10-21" },
	{ id: "p1", tags: ["project:随便问问"], fact_type: "world", updated_at: "2026-10-22" },
	{ id: "o1", tags: ["project:blog"], fact_type: "world", updated_at: "2026-10-19" },
];

test("filterByScope 按层裁剪：全局层=无 tag", () => {
	assert.deepEqual(filterByScope(FACTS, "global", "随便问问").map((f) => f.id), ["g1", "g2"]);
	assert.deepEqual(filterByScope(FACTS, "project", "随便问问").map((f) => f.id), ["p1"]);
	assert.deepEqual(filterByScope(FACTS, "other", "随便问问").map((f) => f.id), ["o1"]);
	assert.equal(filterByScope(FACTS, "all", "随便问问").length, 4);
});

test("describeLayers 给出每层的条数、类型分布与最近更新时间", () => {
	const detail = describeLayers(FACTS, "随便问问");
	assert.equal(detail.global.count, 2);
	assert.equal(detail.global.byType.world, 1);
	assert.equal(detail.global.byType.observation, 1);
	assert.equal(detail.global.latestUpdatedAt, "2026-10-21");
	assert.equal(detail.project.count, 1);
	assert.equal(detail.other.count, 1);
	assert.equal(detail.total, 4);
});
