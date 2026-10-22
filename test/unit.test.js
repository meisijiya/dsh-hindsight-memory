import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULTS, normalizeConfig } from "../src/config.js";
import { normalizeScope, sanitizeMemoryText, sanitizeTags } from "../src/sanitize.js";
import { MEMORY_PROTOCOL, extractUserPrompt, renderRecallMessage } from "../src/prompt.js";
import { projectLabelFromRoot } from "../src/label.js";

test("normalizeConfig 对非法输入一律回落默认值，不抛错", () => {
	const config = normalizeConfig({ scoping: "nope", budget: "huge", apiUrl: 42, maxTokens: "x" });
	assert.equal(config.scoping, DEFAULTS.scoping);
	assert.equal(config.budget, DEFAULTS.budget);
	assert.equal(config.apiUrl, DEFAULTS.apiUrl);
	assert.equal(config.maxTokens, DEFAULTS.maxTokens);
	assert.equal(config.enabled, true);
});

test("normalizeConfig 去尾斜杠、过滤非法 fact 类型", () => {
	const config = normalizeConfig({ apiUrl: "http://x:8888///", types: ["world", "bogus", "observation"] });
	assert.equal(config.apiUrl, "http://x:8888");
	assert.deepEqual(config.types, ["world", "observation"]);
});

test("sanitizeTags 丢弃 source:/harness: provenance 标签（否则 omp 过滤会失效）", () => {
	assert.deepEqual(
		sanitizeTags(["project:x", "source:chat", "harness:dsh", "project:x"]),
		["project:x"],
	);
	assert.deepEqual(sanitizeTags(undefined), []);
	assert.deepEqual(sanitizeTags("a, b"), ["a", "b"]);
});

test("sanitizeMemoryText 去掉 operation_id / uuid / 多余空行", () => {
	const out = sanitizeMemoryText(
		"结论：X 可用 operation_id: 60868b57-bae1-4db9-b4d0-b7257bd8db0b\n\n\n\n结束",
	);
	assert.ok(!out.includes("60868b57"));
	assert.ok(!out.includes("\n\n\n"));
	assert.ok(out.startsWith("结论"));
});

test("normalizeScope 只认三个值", () => {
	assert.equal(normalizeScope("global", "project"), "global");
	assert.equal(normalizeScope("PROJECT_ONLY", "project"), "project_only");
	assert.equal(normalizeScope("weird", "project"), "project");
});

test("projectLabelFromRoot 复刻 omp 的小写 basename 规则", () => {
	assert.equal(projectLabelFromRoot("/d/26code/随便问问"), "随便问问");
	assert.equal(projectLabelFromRoot("/d/26code/MyRepo"), "myrepo");
	assert.equal(projectLabelFromRoot(""), "unknown");
});

test("系统提示词段是常量（不含时间戳/项目名/记忆内容）", () => {
	assert.ok(MEMORY_PROTOCOL.includes("memory_recall"));
	assert.ok(MEMORY_PROTOCOL.includes("memory_retain"));
	assert.ok(!/\d{4}-\d{2}-\d{2}/.test(MEMORY_PROTOCOL));
	assert.ok(!MEMORY_PROTOCOL.includes("随便问问"));
});

test("extractUserPrompt 取最后一条用户文本", () => {
	assert.equal(
		extractUserPrompt([
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "reply" }] },
			{ role: "user", content: [{ type: "text", text: "second" }] },
		]),
		"second",
	);
	assert.equal(extractUserPrompt([]), "");
});

test("renderRecallMessage 标注分层", () => {
	const text = renderRecallMessage(
		[
			{ text: "全局事实", tier: "global" },
			{ text: "项目事实", tier: "project" },
		],
		{ bankId: "shared", scope: "project" },
	);
	assert.ok(text.includes("全局事实 [global]"));
	assert.ok(text.includes("项目事实 [project]"));
	assert.ok(text.includes('bank="shared"'));
	assert.ok(text.startsWith("<memories"));
	assert.ok(text.includes("</memories>"));
});
