/**
 * 记忆看板（v0.7.0）的契约测试：纯函数、零 I/O ⇒ 不需要服务端也能跑。
 *
 * 为什么测这个：看板是「页面看状态」的唯一入口，它一旦算错分层或漏掉
 * 近重复，用户就会照着错的数字做维护决策 —— 那比没有看板更糟。
 * 另外端点契约（白名单、只读、错误信封）也在这里钉死。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	PANEL_ENDPOINTS,
	PANEL_RPC_CHANNEL,
	buildModelSummary,
	buildOperationSummary,
	buildPageSummary,
	buildPanelSnapshot,
	normalizeFactList,
	normalizeModelList,
	normalizeOperationList,
	normalizePageList,
	pickPublicConfig,
} from "../src/panel.js";
import { createPanelRpcHandler } from "../src/panel-rpc.js";
import { DEFAULTS } from "../src/config.js";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");

/** 造一条事实。 */
function fact(id, text, extra = {}) {
	return {
		id,
		text,
		tags: [],
		fact_type: "world",
		created_at: new Date(NOW - 86_400_000).toISOString(),
		updated_at: new Date(NOW - 86_400_000).toISOString(),
		state: "valid",
		...extra,
	};
}

test("面板 RPC 通道名与端点白名单是公开契约", () => {
	assert.equal(PANEL_RPC_CHANNEL, "/dsh-hindsight-memory");
	assert.deepEqual(
		[...PANEL_ENDPOINTS],
		["overview", "layers", "audit", "operations", "models", "pages", "config"],
	);
});

test("列表归一化：接受数组与分页信封", () => {
	assert.equal(normalizeFactList([fact("a", "x")]).length, 1);
	assert.equal(normalizeFactList({ items: [fact("a", "x")] }).length, 1);
	assert.equal(normalizeFactList({ memories: [fact("a", "x")] }).length, 1);
	assert.equal(normalizeFactList({ facts: [fact("a", "x")] }).length, 1);
	assert.equal(normalizeFactList(null).length, 0);
	assert.equal(normalizeFactList(undefined).length, 0);

	assert.equal(normalizeOperationList({ operations: [{ id: "o1" }] }).length, 1);
	assert.equal(normalizeOperationList({ items: [{ id: "o1" }] }).length, 1);
	assert.equal(normalizeOperationList([]).length, 0);

	assert.equal(normalizeModelList({ models: [{ id: "m1" }] }).length, 1);
	assert.equal(normalizeModelList({ items: [{ id: "m1" }] }).length, 1);

	assert.equal(normalizePageList({ pages: [{ id: "p1" }] }).length, 1);
	assert.equal(normalizePageList({ items: [{ id: "p1" }] }).length, 1);
	assert.equal(normalizePageList(null).length, 0);
});

test("操作摘要：统计状态与任务类型，保留最近若干条", () => {
	const summary = buildOperationSummary([
		{ id: "1", status: "completed", task_type: "retain" },
		{ id: "2", status: "completed", task_type: "retain" },
		{ id: "3", status: "failed", task_type: "refresh_mental_model" },
	]);
	assert.equal(summary.total, 3);
	assert.equal(summary.byStatus.completed, 2);
	assert.equal(summary.byStatus.failed, 1);
	assert.equal(summary.byTask.retain, 2);
	assert.equal(summary.recent.length, 3);
});

test("精神模型摘要：标记陈旧与刷新失败", () => {
	const models = buildModelSummary([
		{ id: "m1", name: "user-preferences", tags: [], is_stale: true },
		{ id: "m2", name: "project-x", tags: ["project:x"], last_refresh_failed_at: "2026-05-01T00:00:00Z" },
	]);
	assert.equal(models.length, 2);
	assert.equal(models[0].isStale, true);
	assert.deepEqual(models[1].tags, ["project:x"]);
	assert.equal(models[1].lastRefreshFailedAt, "2026-05-01T00:00:00Z");
});

test("知识页摘要：名字、层级标签、陈旧标记", () => {
	const pages = buildPageSummary([
		{ id: "p1", name: "架构总览", kind: "page", tags: ["project:x"], is_stale: true },
	]);
	assert.equal(pages.length, 1);
	assert.equal(pages[0].name, "架构总览");
	assert.equal(pages[0].isStale, true);
});

test("公开配置是白名单：不含内部细节", () => {
	const publicConfig = pickPublicConfig({
		...DEFAULTS,
		apiKey: "SECRET-SHOULD-NOT-LEAK",
		maintenanceTimeoutMs: 900000,
		sectionOrder: 950,
	});
	assert.equal(publicConfig.apiUrl, DEFAULTS.apiUrl);
	assert.equal(publicConfig.bankId, DEFAULTS.bankId);
	assert.equal("apiKey" in publicConfig, false);
	assert.equal("maintenanceTimeoutMs" in publicConfig, false);
	assert.equal("sectionOrder" in publicConfig, false);
});

test("快照：分层 + 近重复 + 体检三块都在，畸形输入不炸", () => {
	const snapshot = buildPanelSnapshot({
		facts: [
			fact("f1", "同一个事实重复了一次", { tags: ["project:随便问问"] }),
			fact("f2", "同一个事实重复了一次", { tags: ["project:随便问问"] }),
			fact("f3", "全局层的偏好", { tags: [] }),
		],
		operations: [{ id: "o1", status: "completed", task_type: "retain" }],
		models: [{ id: "m1", name: "user-preferences" }],
		pages: [],
		bank: { bankId: "shared", factCount: 3, documentCount: 0, totalBanks: 1, warnings: [] },
		projectLabel: "随便问问",
		now: NOW,
	});

	assert.equal(snapshot.projectLabel, "随便问问");
	assert.equal(snapshot.bank.factCount, 3);
	// 分层：无标签=全局层、project:<label>=项目层
	assert.equal(snapshot.layers.global.count, 1);
	assert.equal(snapshot.layers.project.count, 2);
	assert.equal(snapshot.layers.total, 3);
	// 近重复：两条同文同标签 ⇒ 一组
	assert.ok(snapshot.duplicates.groups >= 1);
	assert.ok(snapshot.duplicates.scanned >= 3);
	// 体检计数
	assert.equal(snapshot.audit.counts.facts, 3);
	assert.ok(snapshot.operations.total >= 1);
	assert.equal(snapshot.models.length, 1);
});

test("快照：完全空的输入给出空结构而不是异常", () => {
	const snapshot = buildPanelSnapshot({});
	assert.equal(snapshot.layers.total, 0);
	assert.equal(snapshot.duplicates.groups, 0);
	assert.equal(snapshot.operations.total, 0);
	assert.deepEqual(snapshot.models, []);
	assert.deepEqual(snapshot.pages, []);
	assert.equal(snapshot.bank, null);
});

test("RPC 处理器：未知端点返回错误信封而不是抛异常", async () => {
	const handler = createPanelRpcHandler({ config: { ...DEFAULTS } });
	const result = await handler("nope", {});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "hindsight/unknown-endpoint");
	assert.equal(typeof result.error.details, "object");
});

test("RPC 处理器：config 端点只回公开字段", async () => {
	const handler = createPanelRpcHandler({
		config: { ...DEFAULTS, apiKey: "SECRET-SHOULD-NOT-LEAK" },
	});
	const result = await handler("config", {});
	assert.equal(result.ok, true);
	assert.equal(result.value.bankId, DEFAULTS.bankId);
	assert.equal("apiKey" in result.value, false);
});

test("RPC 处理器：取数失败时返回面板专用错误码", async () => {
	const handler = createPanelRpcHandler({
		config: { ...DEFAULTS, apiUrl: "http://127.0.0.1:1" },
	});
	const result = await handler("overview", {});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "hindsight/panel-failed");
});

test("RPC 处理器：只读——端点清单里没有任何写动作", () => {
	const source = readFileSync(new URL("../src/panel-rpc.js", import.meta.url), "utf8");
	for (const verb of ["createKnowledgePage(", "deleteKnowledgeNode(", "deleteMentalModel(", "setFactState(", "clearMentalModel(", "updateKnowledgeNode("]) {
		assert.equal(source.includes(verb), false, `看板端点不应出现写操作：${verb}`);
	}
});

test("RPC 处理器注册在宿主的 connection 通道上，而不是自建 HTTP 路由", () => {
	const indexSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
	assert.ok(indexSource.includes('ctx.inject(["connection"]'), "应通过 ctx.inject 声明 connection 依赖");
	assert.ok(indexSource.includes("connection.rpc.handle("), "应注册宿主 RPC 通道");
	assert.ok(indexSource.includes('PANEL_RPC_CHANNEL'), "通道名应来自 panel.js 的常量");
});

test("取 connection 必须 root 优先：scope.get 视角的实例解析不到 webServer", async () => {
	// 回归 v0.7.0 的 405 事故：connection.rpc.handle() 内部会走
	// `owner.effect(() => owner.webServer.register(...))`，owner 是实例自己的 this.ctx。
	// scope.get("connection") 拿到的是当前 fiber 视角的实例（其 ctx 解析不到 webServer），
	// 注册会抛 `cannot get property "webServer" without inject`；root 上的实例才可用。
	const mod = await import("../src/index.js");
	const registered = [];
	const broken = {
		rpc: {
			handle: () => {
				throw new Error('cannot get property "webServer" without inject');
			},
		},
	};
	const working = {
		rpc: {
			handle: (channel, handler) => {
				registered.push({ channel, handler });
				return () => {};
			},
		},
	};
	const ctx = {
		tools: { register: () => {} },
		systemPrompt: { section: () => () => {} },
		logger: { warn: () => {} },
		on: () => {},
		effect: () => {},
		workingDirectory: { get: () => process.cwd() },
		inject: (deps, callback) => {
			assert.deepEqual(deps, ["connection"]);
			callback({
				get: () => broken,
				root: { connection: working },
				effect: () => {},
			});
		},
	};
	await mod.apply(ctx, {});
	assert.equal(registered.length, 1, "应通过 root 上的 connection 实例注册一次通道");
	assert.equal(registered[0].channel, "/dsh-hindsight-memory");
	assert.equal(typeof registered[0].handler, "function");
});

test("client 半体注册了 plugins.detail.section 席位并声明 connection 依赖", () => {
	const clientSource = readFileSync(new URL("../src/ui-client.js", import.meta.url), "utf8");
	assert.ok(clientSource.includes('ctx.slots.inject("plugins.detail.section"'), "应注册看板席位");
	assert.ok(clientSource.includes('id: "dsh-hindsight-memory-health"'), "席位必须给 id");
	assert.ok(clientSource.includes('const inject = ["slots", "connection"]'), "client 半体应声明 connection 服务依赖");
	assert.ok(clientSource.includes("connection.rpc.call("), "看板取数应走宿主 RPC 通道");
	// 看板是只读的：client 半体里不能**调用**写工具（文档里提到字段名不算）。
	const writeToolCalls = clientSource.match(/\bmemory_(retain|hygiene|pages|initiative|mental_models|operations)\s*\(/g);
	assert.equal(writeToolCalls, null, `看板不应调用写工具：${writeToolCalls}`);
});

test("package.json 声明了 client-connection 依赖（宿主自带，缺失也不致命）", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.ok(
		pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-connection"),
		"dsh.client.inject 应包含 client-connection",
	);
	assert.ok(
		pkg.peerDependencies["@deepseek-ai/dsh-client-connection"],
		"peerDependencies 应声明 client-connection 版本范围",
	);
});
