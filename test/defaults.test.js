/**
 * 默认值一致性门禁。
 *
 * 为什么测这个：🔴 实测 DSH 运行时**没有把行配置投递给本插件**
 * （改 profile 的 cordis.patch.yml 与插件自带的 cordis.patch.yml 都不生效，
 *   改 src/config.js 的 DEFAULTS 才立刻生效）⇒ 真正决定运行时行为的是 DEFAULTS。
 * 但插件自带的 cordis.patch.yml 会在 `dsh plugin add` 时插入一行配置，
 * schema.js / ui-client.js 又各自带一份默认值给人看——
 * 四处只要有一处漂移，UI 上显示的与实际跑的就不是一回事。
 *
 * 所以这里把「四层默认值必须一致」钉成测试。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEFAULTS } from "../src/config.js";

const root = new URL("../", import.meta.url);

/** 从 YAML 文本里取 `key: 'value'` 形式的标量（只取第一处命中）。 */
function yamlScalar(text, key) {
	const match = text.match(new RegExp(`^\\s*${key}:\\s*['"]?([^'"\n]+)['"]?\\s*$`, "m"));
	return match?.[1]?.trim() ?? null;
}

/** 从 JS 源码里取 `key: "value"` 形式的对象字段。 */
function jsField(text, key) {
	const match = text.match(new RegExp(`key:\\s*"${key}",[\\s\\S]{0,200}?default:\\s*"([^"]+)"`));
	return match?.[1] ?? null;
}

test("DEFAULTS 与本机 omp 的 hindsight 配置一致（mem / per-project）", () => {
	assert.equal(DEFAULTS.bankId, "mem");
	assert.equal(DEFAULTS.scoping, "per-project");
	assert.equal(DEFAULTS.mentalModelPrefix, "", "精神模型 id 前缀必须为空，才能与 omp 共用同一份模型");
});

test("插件自带的 cordis.patch.yml 与 DEFAULTS 一致", async () => {
	const text = await readFile(new URL("cordis.patch.yml", root), "utf8");
	assert.equal(yamlScalar(text, "bankId"), DEFAULTS.bankId);
	assert.equal(yamlScalar(text, "scoping"), DEFAULTS.scoping);
});

test("schema.js 与 ui-client.js 的默认值与 DEFAULTS 一致", async () => {
	const schema = await readFile(new URL("src/schema.js", root), "utf8");
	assert.match(schema, new RegExp(`bankId:\\s*z\\.string\\(\\)\\.default\\("${DEFAULTS.bankId}"\\)`));
	assert.match(schema, new RegExp(`scoping:\\s*z\\.string\\(\\)\\.default\\("${DEFAULTS.scoping}"\\)`));

	const ui = await readFile(new URL("src/ui-client.js", root), "utf8");
	assert.equal(jsField(ui, "bankId"), DEFAULTS.bankId);
	assert.equal(jsField(ui, "scoping"), DEFAULTS.scoping);
});
