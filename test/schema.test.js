/**
 * 配置 schema 的契约测试。
 *
 * 为什么测这个：宿主的「插件 → 配置」表单**只显示 volatile 字段**
 * （`dsh-settings` 的 `volatileForm()` 会把非 volatile 字段整段裁掉），
 * 且只有运行中的插件行才会被投影成可编辑配置项。
 * 少了 volatile 标记 ⇒ 插件页永远显示「settings namespace 未就绪」，
 * 而插件本身照常工作——这种"功能全在但看不见"的坑，必须有测试钉住。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Config, LiveConfig, FIELD_DOCS } from "../src/schema.js";

test("schema 覆盖与 omp 对齐所需的字段", () => {
	const keys = Object.keys(Config?.dict ?? {});
	for (const key of [
		"apiUrl",
		"bankId",
		"bankIdPrefix",
		"scoping",
		"types",
		"budget",
		"reflectBudget",
		"maxTokens",
		"autoRecall",
		"autoRetain",
		"retainEveryNTurns",
		"hygieneThreshold",
		"hygieneProjectMaxObservations",
		"hygieneGlobalMaxObservations",
	]) {
		assert.ok(keys.includes(key), `schema 缺少字段 ${key}`);
	}
});

test("每个字段都有说明文案", () => {
	for (const [key, doc] of Object.entries(FIELD_DOCS)) {
		assert.equal(typeof doc, "string", `${key} 的说明不是字符串`);
		assert.ok(doc.length > 0, `${key} 的说明为空`);
	}
});

test("LiveConfig 把所有字段标成 volatile（宿主配置表单只认 volatile 字段）", () => {
	const dict = LiveConfig?.dict ?? {};
	const keys = Object.keys(dict);
	if (keys.length === 0) {
		// schemastery 不可用时的降级路径：没有 schema 就没有表单，属已知取舍。
		assert.equal(LiveConfig, Config, "降级时 LiveConfig 应等于 Config");
		return;
	}
	for (const key of keys) {
		assert.equal(dict[key]?.meta?.volatile, true, `${key} 未标记 volatile`);
	}
});
