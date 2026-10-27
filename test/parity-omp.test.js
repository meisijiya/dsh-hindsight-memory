import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HindsightMemoryClient } from "../src/client.js";
import { DEFAULTS, normalizeConfig } from "../src/config.js";
import { buildRetainPayload, localTimestamp, mentalModelVisible } from "../src/parity.js";
import { mentalModelIds } from "../src/mental-models.js";

const SRC_DIR = new URL("../src/", import.meta.url);
const readSrc = (name) => readFile(new URL(name, SRC_DIR), "utf8");

test("recall 请求体只发 omp 的 6 个字段（对齐报告 §3.4）", async () => {
	const config = normalizeConfig({ transport: "rest", bankId: "shared", scoping: "per-project-tagged" });
	const client = new HindsightMemoryClient({ config, label: "随便问问" });
	let captured = null;
	client.postJson = async (path, body) => {
		captured = { path, body };
		return { results: [] };
	};
	await client.recall({ query: "测一下", scope: "project" });
	assert.ok(captured, "recall 应该发出请求");
	const keys = Object.keys(captured.body).sort();
	assert.deepEqual(keys, ["budget", "max_tokens", "query", "tags", "tags_match", "types"]);
	assert.equal(captured.body.prefer_observations, undefined, "不发 prefer_observations（omp 也不发）");
	assert.equal(captured.body.filter, undefined, "不发 filter（服务端会静默忽略）");
	assert.deepEqual(captured.body.tags, ["project:随便问问"]);
	assert.equal(captured.body.tags_match, "any");
});

test("源码里不存在 PUT /banks（DSH 不得改写共享 bank 的 mission）", async () => {
	const files = ["client.js", "index.js", "parity.js", "mental-models.js", "hygiene.js"];
	for (const name of files) {
		const text = await readSrc(name);
		assert.equal(/method:\s*"PUT"/.test(text), false, `${name} 不应出现 PUT`);
		assert.equal(/putJson\s*\(/.test(text), false, `${name} 不应出现 putJson`);
	}
});

test("retain 写入带本地时区时间戳与 metadata.session_id（对齐报告 §3.5）", async () => {
	const config = normalizeConfig({ transport: "rest", bankId: "shared" });
	const client = new HindsightMemoryClient({ config, label: "随便问问" });
	let captured = null;
	client.postJson = async (path, body) => {
		captured = body;
		return { success: true };
	};
	const result = await client.retain({ content: "一条记忆", tier: "project", sessionId: "sess-123" });
	assert.equal(captured.async, true, "写入必须 async（抽取异步完成）");
	const item = captured.items[0];
	assert.equal(item.content, "一条记忆");
	assert.deepEqual(item.tags, ["project:随便问问"]);
	assert.match(item.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
	assert.equal(item.metadata.session_id, "sess-123");
	assert.equal(result.timestamp, item.timestamp);
});

test("localTimestamp 输出带时区偏移的本地时间", () => {
	const stamp = localTimestamp(new Date(2026, 9, 22, 16, 48, 3));
	assert.match(stamp, /^2026-10-22T16:48:03[+-]\d{2}:\d{2}$/);
});

test("buildRetainPayload 没给 sessionId / timestamp 时不塞空字段", () => {
	const payload = buildRetainPayload({ content: " x ", tags: ["project:a"] });
	assert.deepEqual(payload, { items: [{ content: "x", tags: ["project:a"] }] });
});

test("mental model 的 max_tokens 下限是 256（服务端 422 的硬门槛）", () => {
	const low = normalizeConfig({ mentalModelUserMaxTokens: 10, mentalModelProjectMaxTokens: 10 });
	assert.equal(low.mentalModelUserMaxTokens, 256);
	assert.equal(low.mentalModelProjectMaxTokens, 256);
	assert.equal(DEFAULTS.mentalModelUserMaxTokens, 600);
	assert.equal(DEFAULTS.mentalModelProjectMaxTokens, 800);
});

test("精神模型的可见性与 omp 同规则：只按 scope 过滤，不按 id 过滤", () => {
	// per-project / global：scope 为空 ⇒ 不过滤，bank 里每个模型都注入（与 omp 一致）。
	assert.equal(mentalModelVisible({ id: "anything", tags: [] }, []), true);
	assert.equal(mentalModelVisible({ id: "anything", tags: ["project:x"] }, []), true);
	// per-project-tagged：无 tag 的模型可见；命中 scope tag 的可见；别的不可见。
	assert.equal(mentalModelVisible({ id: "a", tags: [] }, ["project:blog"]), true);
	assert.equal(mentalModelVisible({ id: "a", tags: ["project:blog"] }, ["project:blog"]), true);
	assert.equal(mentalModelVisible({ id: "a", tags: ["project:other"] }, ["project:blog"]), false);
});

test("mental model id 默认与 omp 完全相同（两端共用同一份模型）", () => {
	const config = normalizeConfig({ scoping: "per-project" });
	assert.equal(config.mentalModelPrefix, "");
	const ids = mentalModelIds(config, "随便问问");
	assert.equal(ids.user, "user-preferences");
	assert.equal(ids.conventions, "project-conventions");
	assert.equal(ids.decisions, "project-decisions");
});

test("自动留存节奏对齐 omp（retainEveryNTurns 默认 3，且不被 0/负数击穿）", () => {
	assert.equal(DEFAULTS.retainEveryNTurns, 3);
	assert.equal(normalizeConfig({}).retainEveryNTurns, 3);
	assert.equal(normalizeConfig({ retainEveryNTurns: 0 }).retainEveryNTurns, 1);
	assert.equal(normalizeConfig({ retainEveryNTurns: -5 }).retainEveryNTurns, 1);
	assert.equal(normalizeConfig({ retainEveryNTurns: 7 }).retainEveryNTurns, 7);
});
