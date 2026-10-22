import test from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_PAGE_TRIGGER,
	INITIATIVE_TAG,
	buildPageRequest,
	filterPagesByScope,
	findInitiativeMarkers,
	flattenTree,
	initiativeMarkerContent,
	initiativeMarkerContext,
	initiativeSourceQuery,
	normalizeSearchResults,
	normalizeTags,
	pageTags,
	slugify,
} from "../src/pages.js";
import { normalizeConfig } from "../src/config.js";

test("slugify 保留中文、去空白与标点、空标题回落", () => {
	assert.equal(slugify("随便 问问"), "随便-问问");
	assert.equal(slugify("Hindsight MCP 落地!"), "hindsight-mcp-落地");
	assert.equal(slugify("   "), "initiative");
	assert.equal(slugify("!!!", "fallback"), "fallback");
});

test("initiative 的 source_query 固定问句且含标题", () => {
	const q = initiativeSourceQuery("统一记忆层");
	assert.ok(q.includes("统一记忆层"));
	assert.ok(q.includes("目标"));
	assert.ok(initiativeSourceQuery("").length > 0);
});

test("pageTags 项目标签在前、附加标签在后、去重", () => {
	assert.deepEqual(pageTags(["project:随便问问"], [INITIATIVE_TAG]), [
		"project:随便问问",
		INITIATIVE_TAG,
	]);
	assert.deepEqual(pageTags(["project:a"], ["project:a"]), ["project:a"]);
	assert.deepEqual(pageTags([], []), []);
});

test("normalizeTags 丢弃空串与非数组", () => {
	assert.deepEqual(normalizeTags(["a", "", "  ", "b"]), ["a", "b"]);
	assert.deepEqual(normalizeTags(null), []);
});

test("buildPageRequest 必填字段齐、max_tokens 不低于服务端下限", () => {
	const request = buildPageRequest({
		title: "记忆层设计",
		sourceQuery: "这页回答什么？",
		tags: ["project:随便问问"],
	});
	assert.equal(request.name, "记忆层设计");
	assert.equal(request.source_query, "这页回答什么？");
	assert.deepEqual(request.tags, ["project:随便问问"]);
	assert.equal(request.max_tokens, 2000);
	assert.equal(request.parent_id, undefined);
	assert.equal(request.trigger, undefined);

	const clamped = buildPageRequest({ title: "x", sourceQuery: "y", maxTokens: 10 });
	assert.equal(clamped.max_tokens, 256, "服务端硬性要求 max_tokens >= 256");
});

test("buildPageRequest 带上 parent_id 与 trigger", () => {
	const request = buildPageRequest({
		title: "t",
		sourceQuery: "q",
		parentId: "folder-1",
		trigger: DEFAULT_PAGE_TRIGGER,
	});
	assert.equal(request.parent_id, "folder-1");
	assert.deepEqual(request.trigger, { mode: "delta", refresh_after_consolidation: true });
});

test("flattenTree 分出文件夹与页，递归子节点并记录深度", () => {
	const tree = {
		roots: [
			{
				id: "f1",
				kind: "folder",
				name: "Initiatives",
				children: [
					{ id: "p1", kind: "page", name: "计划 A", tags: ["project:x"] },
				],
			},
			{ id: "p2", kind: "page", name: "总览", tags: [] },
		],
	};
	const flat = flattenTree(tree);
	assert.equal(flat.folders.length, 1);
	assert.equal(flat.folders[0].name, "Initiatives");
	assert.equal(flat.pages.length, 2);
	const plan = flat.pages.find((page) => page.id === "p1");
	assert.equal(plan.parentId, "f1");
	assert.equal(plan.depth, 1);
	assert.deepEqual(plan.tags, ["project:x"]);
});

test("flattenTree 对空/畸形输入不炸", () => {
	assert.deepEqual(flattenTree({}), { folders: [], pages: [] });
	assert.deepEqual(flattenTree(null), { folders: [], pages: [] });
	assert.deepEqual(flattenTree({ roots: [null, 3] }), { folders: [], pages: [] });
});

test("filterPagesByScope 沿用 recall 的白名单语义（无标签=全局层）", () => {
	const items = [
		{ id: "1", tags: [] },
		{ id: "2", tags: ["project:随便问问"] },
		{ id: "3", tags: ["project:别的仓库"] },
		{ id: "4", tags: ["source:chat"] },
	];
	const visible = filterPagesByScope(items, ["project:随便问问"]).map((item) => item.id);
	assert.deepEqual(visible, ["1", "2"], "无标签与本项目标签可见；只带无关标签的不可见");
});

test("normalizeSearchResults 兼容多种返回形状", () => {
	assert.equal(normalizeSearchResults({ results: [{ id: "a", name: "A" }] }).length, 1);
	assert.equal(normalizeSearchResults({ items: [{ page_id: "b", title: "B" }] })[0].id, "b");
	assert.equal(normalizeSearchResults(null).length, 0);
	assert.equal(normalizeSearchResults({ results: [{ id: "c", score: 0.5 }] })[0].score, 0.5);
});

test("initiative 标记事实的正文与 context 与服务端页链接同格式", () => {
	const content = initiativeMarkerContent("统一记忆层", "p-42");
	assert.ok(content.includes("统一记忆层"));
	assert.ok(content.includes("[[page:p-42]]"));
	assert.equal(initiativeMarkerContext("p-42"), "initiative marker for [[page:p-42]]");
});

test("findInitiativeMarkers 只挑 context 命中 initiative 标记的事实", () => {
	const facts = [
		{ id: "1", context: "initiative marker for [[page:p1]]" },
		{ id: "2", context: "auto-retain from DSH turn" },
		{ id: "3", context: "" },
	];
	assert.deepEqual(
		findInitiativeMarkers(facts).map((fact) => fact.id),
		["1"],
	);
});

test("配置：知识页默认开启，页 token 下限 256", () => {
	const config = normalizeConfig({});
	assert.equal(config.knowledgePages, true);
	assert.equal(config.pageSearchLimit, 5);
	assert.equal(config.pageMaxTokens, 2000);
	assert.equal(config.initiativeFolder, "Initiatives");
	assert.equal(normalizeConfig({ pageMaxTokens: 10 }).pageMaxTokens, 256);
	assert.equal(normalizeConfig({ knowledgePages: false }).knowledgePages, false);
});
