import test from "node:test";
import assert from "node:assert/strict";

import {
	findDuplicateGroups,
	normalizeForCompare,
	planPrune,
	similarity,
	summarizeGroups,
	tagSignature,
	tokenize,
} from "../src/hygiene.js";

test("normalizeForCompare 抹掉空白与标点", () => {
	assert.equal(normalizeForCompare("A, B。"), "ab");
	assert.equal(normalizeForCompare("  hello   world "), "helloworld");
});

test("tokenize 对中文产出二元组", () => {
	const tokens = tokenize("记忆分层");
	assert.ok(tokens.has("记忆"));
	assert.ok(tokens.has("忆分"));
	assert.ok(tokens.has("分层"));
});

test("similarity：同句=1，无关句远小于阈值", () => {
	assert.equal(similarity("双层标签", "双层标签"), 1);
	assert.ok(similarity("Docker 容器 hindsight 在跑", "今天天气不错") < 0.2);
});

test("tagSignature 忽略标签顺序", () => {
	assert.equal(tagSignature({ tags: ["b", "a"] }), tagSignature({ tags: ["a", "b"] }));
	assert.notEqual(tagSignature({ tags: ["a"] }), tagSignature({ tags: [] }));
});

test("findDuplicateGroups：同层同文 ⇒ 一组", () => {
	const facts = [
		{ id: "1", text: "跨 agent 记忆统一为单 bank 加双层标签", tags: ["project:随便问问"], updated_at: "2026-10-22T01:00:00Z" },
		{ id: "2", text: "跨 agent 记忆统一为单 bank 加双层标签", tags: ["project:随便问问"], updated_at: "2026-10-22T02:00:00Z" },
		{ id: "3", text: "完全不同的另一条事实", tags: ["project:随便问问"], updated_at: "2026-10-22T03:00:00Z" },
	];
	const { groups } = findDuplicateGroups(facts, { threshold: 0.9 });
	assert.equal(groups.length, 1);
	assert.equal(groups[0].members.length, 2);
});

test("findDuplicateGroups：跨层同文不进重复组，落到 crossScope", () => {
	const facts = [
		{ id: "1", text: "Hindsight 服务在 8888 端口", tags: [] },
		{ id: "2", text: "Hindsight 服务在 8888 端口", tags: ["project:随便问问"] },
	];
	const { groups, crossScope } = findDuplicateGroups(facts, { threshold: 0.9 });
	assert.equal(groups.length, 0);
	assert.equal(crossScope.length, 1);
});

test("planPrune 保留最新的一条", () => {
	const groups = [
		{
			signature: "project:x",
			members: [
				{ id: "old", text: "t", updated_at: "2026-10-21T00:00:00Z" },
				{ id: "new", text: "t", updated_at: "2026-10-22T00:00:00Z" },
			],
		},
	];
	const plan = planPrune(groups);
	assert.equal(plan.keep.length, 1);
	assert.equal(plan.keep[0].id, "new");
	assert.equal(plan.invalidate.length, 1);
	assert.equal(plan.invalidate[0].id, "old");
});

test("summarizeGroups 输出可读摘要", () => {
	const summary = summarizeGroups([
		{ signature: "project:x", members: [{ id: "1", text: "hello world" }] },
	]);
	assert.equal(summary.length, 1);
	assert.equal(summary[0].scope, "project:x");
	assert.equal(summary[0].samples[0].text, "hello world");
});

test("observation（服务端归纳层）默认不参与去重", () => {
	const facts = [
		{ id: "o1", text: "容器 hindsight 在 8888 端口提供服务", fact_type: "observation", tags: ["project:x"] },
		{ id: "o2", text: "容器 hindsight 在 8888 端口提供服务", fact_type: "observation", tags: ["project:x"] },
	];
	const { groups } = findDuplicateGroups(facts, { threshold: 0.9 });
	assert.equal(groups.length, 0, "默认不动 observation");
	const withObs = findDuplicateGroups(facts, { threshold: 0.9, includeObservations: true });
	assert.equal(withObs.groups.length, 1, "显式开启后可去重");
});

test("world 与 observation 同文不算重复（类型进签名）", () => {
	const facts = [
		{ id: "w", text: "完全一样的一句话", fact_type: "world", tags: [] },
		{ id: "o", text: "完全一样的一句话", fact_type: "observation", tags: [] },
	];
	const { groups } = findDuplicateGroups(facts, { threshold: 0.9 });
	assert.equal(groups.length, 0);
});
