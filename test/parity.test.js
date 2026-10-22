import assert from "node:assert/strict";
import test from "node:test";

import {
	PROJECT_TAG_PREFIX,
	SCOPE,
	TIER,
	baseBankId,
	buildRetainPayload,
	computeBankScope,
	filterUntagged,
	normalizeFacts,
	recallFilter,
	retainTags,
	tierOf,
} from "../src/parity.js";

const tagged = { bankId: "shared", bankIdPrefix: "", scoping: "per-project-tagged" };

test("baseBankId 复刻 omp：prefix 非空才拼", () => {
	assert.equal(baseBankId({ bankId: "shared" }), "shared");
	assert.equal(baseBankId({ bankId: "shared", bankIdPrefix: "omp" }), "omp-shared");
	assert.equal(baseBankId({}), "omp");
});

test("computeBankScope 三种模式与 omp 一致", () => {
	assert.deepEqual(computeBankScope({ ...tagged, scoping: "global" }, "x"), {
		bankId: "shared",
		retainTags: [],
		recallTags: [],
		recallTagsMatch: undefined,
	});
	assert.deepEqual(computeBankScope({ ...tagged, scoping: "per-project" }, "x"), {
		bankId: "shared-x",
		retainTags: [],
		recallTags: [],
		recallTagsMatch: undefined,
	});
	const taggedScope = computeBankScope(tagged, "x");
	assert.equal(taggedScope.bankId, "shared");
	assert.deepEqual(taggedScope.retainTags, [`${PROJECT_TAG_PREFIX}x`]);
	assert.deepEqual(taggedScope.recallTags, [`${PROJECT_TAG_PREFIX}x`]);
	assert.equal(taggedScope.recallTagsMatch, "any");
});

test("retainTags：项目层盖章、global 层不带标签", () => {
	assert.deepEqual(retainTags(tagged, "x", TIER.PROJECT), ["project:x"]);
	assert.deepEqual(retainTags(tagged, "x", TIER.GLOBAL), []);
	assert.deepEqual(retainTags({ ...tagged, scoping: "per-project" }, "x", TIER.PROJECT), ["project:x"]);
});

test("recallFilter：project=项目+全局；project_only=严格项目；global=客户端过滤", () => {
	const project = recallFilter(tagged, "x", SCOPE.PROJECT);
	assert.deepEqual(project.tags, ["project:x"]);
	assert.equal(project.tags_match, "any");
	assert.equal(project.clientFilter, null);

	const only = recallFilter(tagged, "x", SCOPE.PROJECT_ONLY);
	assert.equal(only.tags_match, "any_strict");

	const global = recallFilter(tagged, "x", SCOPE.GLOBAL);
	assert.deepEqual(global.tags, []);
	assert.equal(global.clientFilter, "untagged");
});

test("global / per-project 模式下没有标签轴", () => {
	assert.deepEqual(recallFilter({ ...tagged, scoping: "global" }, "x", SCOPE.PROJECT).tags, []);
	assert.deepEqual(recallFilter({ ...tagged, scoping: "per-project" }, "x", SCOPE.PROJECT).tags, []);
});

test("tierOf：无标签 = 全局层", () => {
	assert.equal(tierOf({ tags: [] }), TIER.GLOBAL);
	assert.equal(tierOf({ tags: ["project:x"] }), TIER.PROJECT);
	assert.equal(tierOf({}), TIER.GLOBAL);
});

test("normalizeFacts 兼容 results / memories / items / MCP content 包装", () => {
	const facts = normalizeFacts({
		results: [
			{ id: "a", text: "hello", tags: [] },
			{ id: "b", content: "world", tags: ["project:x"] },
		],
	});
	assert.equal(facts.length, 2);
	assert.equal(facts[0].tier, TIER.GLOBAL);
	assert.equal(facts[1].tier, TIER.PROJECT);
	assert.equal(facts[1].text, "world");

	const wrapped = normalizeFacts({ content: [{ type: "text", text: JSON.stringify({ results: [{ text: "z" }] }) }] });
	assert.equal(wrapped.length, 1);
	assert.equal(wrapped[0].text, "z");

	assert.deepEqual(normalizeFacts({ memories: [{ text: "m" }] })[0].tags, []);
});

test("filterUntagged 只保留无标签事实", () => {
	const facts = normalizeFacts({ results: [{ text: "a", tags: [] }, { text: "b", tags: ["project:x"] }] });
	const only = filterUntagged(facts);
	assert.equal(only.length, 1);
	assert.equal(only[0].text, "a");
});

test("buildRetainPayload 始终带 tags 数组（空数组 = 全局层）", () => {
	const payload = buildRetainPayload({ content: "x", tags: [] });
	assert.deepEqual(payload, { items: [{ content: "x", tags: [] }] });
});
