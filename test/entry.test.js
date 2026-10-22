/**
 * 入口文件的契约测试。
 *
 * 为什么测这个：v0.3.0 曾在入口里写 `export default { name, inject, Config, apply }`，
 * 而 `Config` 只是 `export { LiveConfig as Config }` 这个**再导出**——它在模块作用域里
 * 没有同名绑定，于是模块求值时直接抛 `ReferenceError: Config is not defined`，
 * 宿主把整行插件判为「failed to import」，插件**静默不加载**。
 * 单测当时全绿，因为没有任何用例 import 入口文件。
 *
 * 这条用例把「入口必须能被真的 import 出来」钉住。
 */

import test from "node:test";
import assert from "node:assert/strict";

test("入口模块可以被 import（宿主加载插件的方式）", async () => {
	const mod = await import("../src/index.js");
	assert.equal(typeof mod.apply, "function", "apply 必须是函数");
	assert.equal(typeof mod.name, "string");
	assert.ok(Array.isArray(mod.inject) && mod.inject.includes("tools"));
});

test("默认导出带可用的 Config（宿主按 default.Config 读配置 schema）", async () => {
	const mod = await import("../src/index.js");
	const def = mod.default;
	assert.ok(def, "缺少默认导出");
	assert.equal(typeof def.apply, "function", "默认导出的 apply 必须是函数");
	assert.equal(def.name, mod.name);
	assert.ok(def.Config, "默认导出缺少 Config");
	const dict = def.Config?.dict ?? {};
	if (Object.keys(dict).length > 0) {
		for (const key of Object.keys(dict)) {
			assert.equal(dict[key]?.meta?.volatile, true, `${key} 未标记 volatile`);
		}
	}
});
