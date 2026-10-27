/**
 * HindsightMemoryClient 的 I/O 契约：URL、方法、服务端语义都要钉死。
 *
 * 为什么测这个：这些方法直连服务端约定（路由语义、字段名），服务端小版本一改
 * 就悄悄失效 —— 例如 operation 的 DELETE 有「取消」和「真删」两条路由，
 * 打错一条就是「以为删了，其实那行还在」。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { HindsightMemoryClient, HindsightError } from "../src/client.js";
import { normalizeConfig } from "../src/config.js";

/**
 * 起一个假服务端：handler 按 URL 分发，返回 Response 与调用记录。
 *
 * 🔴 配置里显式钉死 bankId/scoping：这些用例断言的是 URL 里的库名，
 * 不能跟着 src/config.js 的 DEFAULTS 漂（DEFAULTS 是本机部署值，会变）。
 * @param {(url: string, init: object) => Response} handler
 */
function withFakeServer(handler) {
	const calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), method: init?.method ?? "GET" });
		return handler(String(url), init ?? {});
	};
	const client = new HindsightMemoryClient({
		config: normalizeConfig({
			apiUrl: "http://hindsight.test",
			bankId: "shared",
			scoping: "global",
		}),
		label: "demo",
		log: () => {},
	});
	return {
		calls,
		client,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("deleteOperation：先取消再真删（pending 任务）", async () => {
	const fake = withFakeServer((url) => {
		if (url.endsWith("/operations/op-1/delete")) return json({ success: true });
		return json({ status: "cancelled" });
	});
	try {
		const result = await fake.client.deleteOperation("op-1");
		assert.equal(result.cancelled, true);
		assert.equal(result.deleted, true);
		assert.deepEqual(
			fake.calls.map((c) => `${c.method} ${c.url}`),
			[
				"DELETE http://hindsight.test/v1/default/banks/shared/operations/op-1",
				"DELETE http://hindsight.test/v1/default/banks/shared/operations/op-1/delete",
			],
		);
	} finally {
		fake.restore();
	}
});

test("deleteOperation：任务已终态时取消返回 409，仍要真删", async () => {
	const fake = withFakeServer((url) => {
		if (url.endsWith("/operations/op-2/delete")) return json({ success: true });
		return json({ detail: "Operation op-2 cannot be cancelled: status is 'completed'" }, 409);
	});
	try {
		const result = await fake.client.deleteOperation("op-2");
		assert.equal(result.cancelled, false);
		assert.equal(result.deleted, true);
		assert.match(result.cancelError, /409/);
		assert.equal(fake.calls.length, 2);
	} finally {
		fake.restore();
	}
});

test("deleteOperation：真删失败要抛错，不能静默当成功", async () => {
	const fake = withFakeServer((url) => {
		if (url.endsWith("/operations/op-3/delete")) return json({ detail: "boom" }, 500);
		return json({ status: "cancelled" });
	});
	try {
		await assert.rejects(() => fake.client.deleteOperation("op-3"), HindsightError);
	} finally {
		fake.restore();
	}
});

test("bankOverview：bank 列表没有 document_count 时从 /stats 取文档数", async () => {
	const fake = withFakeServer((url) => {
		if (url.endsWith("/v1/default/banks")) {
			return json({ banks: [{ bank_id: "shared", fact_count: 1459 }] });
		}
		if (url.endsWith("/v1/default/banks/shared/stats")) {
			return json({ total_nodes: 1459, total_documents: 195 });
		}
		return json({ detail: "not found" }, 404);
	});
	try {
		const overview = await fake.client.bankOverview();
		assert.equal(overview.factCount, 1459);
		assert.equal(overview.documentCount, 195);
		assert.deepEqual(overview.warnings, []);
	} finally {
		fake.restore();
	}
});

test("bankOverview：bank 列表已带 document_count 时不再多打一次 /stats", async () => {
	const fake = withFakeServer((url) => {
		if (url.endsWith("/v1/default/banks")) {
			return json({ banks: [{ bank_id: "shared", fact_count: 3, document_count: 7 }] });
		}
		return json({ detail: "not found" }, 404);
	});
	try {
		const overview = await fake.client.bankOverview();
		assert.equal(overview.documentCount, 7);
		assert.equal(fake.calls.length, 1);
	} finally {
		fake.restore();
	}
});

test("bankOverview：/stats 取不到时只告警，不让概览整体失败", async () => {
	const fake = withFakeServer((url) => {
		if (url.endsWith("/v1/default/banks")) {
			return json({ banks: [{ bank_id: "shared", fact_count: 1459 }] });
		}
		return json({ detail: "boom" }, 500);
	});
	try {
		const overview = await fake.client.bankOverview();
		assert.equal(overview.factCount, 1459);
		assert.equal(overview.documentCount, null);
		assert.equal(overview.warnings.length, 1);
		assert.match(overview.warnings[0], /统计/);
	} finally {
		fake.restore();
	}
});
