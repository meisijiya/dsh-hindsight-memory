/**
 * 市场索引契约测试（零依赖、零子进程 ⇒ 沙箱里也能跑）。
 *
 * 真实踩过的坑：index.json 里 `source.commit` 写成了 7 位短 sha，
 * 宿主解析器要求 40 位小写 hex ⇒ 整份索引被拒 ⇒ 插件在「插件 → 发现」里直接消失，
 * 而宿主只报一句「索引加载失败」。这里把关键规则钉死，防止再犯。
 *
 * 完整的闸门（含宿主解析器与 git 对账）见 scripts/validate-market-index.mjs。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(readFileSync(path.join(repoRoot, "index.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

const plugin = index.plugins?.find((entry) => entry.name === "dsh-hindsight-memory");
const versions = plugin?.versions ?? [];

test("index.json 是 format 1 且带双语标题", () => {
	assert.equal(index.format, 1);
	assert.ok(index.title?.en, "title.en 必填");
	assert.ok(index.description?.en, "description.en 必填");
});

test("索引里的插件名与 package.json 一致", () => {
	assert.ok(plugin, "索引里必须有一条 name=dsh-hindsight-memory");
	assert.equal(plugin.name, manifest.name);
});

test("每个版本的 commit 都是 40 位小写 hex（宿主要求，短 sha 会被整份拒收）", () => {
	for (const version of versions) {
		assert.match(version.source.commit, COMMIT_SHA, `版本 ${version.version} 的 commit 不合法`);
	}
});

test("版本号互不重复且是精确 SemVer", () => {
	const seen = new Set();
	for (const version of versions) {
		assert.match(version.version, SEMVER, `版本号 ${version.version} 不是精确 SemVer`);
		assert.equal(seen.has(version.version), false, `版本号 ${version.version} 重复`);
		seen.add(version.version);
	}
});

test("publishTimestamp 是 [0, 1e11) 内的整数秒", () => {
	for (const version of versions) {
		assert.equal(Number.isInteger(version.publishTimestamp), true);
		assert.ok(version.publishTimestamp >= 0 && version.publishTimestamp < 1e11);
	}
});

test("每个版本都声明了 engines.dsh 的 SemVer range", () => {
	for (const version of versions) {
		const range = version.engines?.dsh;
		assert.ok(range, `版本 ${version.version} 缺 engines.dsh`);
		assert.ok(range.includes(">=") || range.includes("<") || range.includes("^") || range.includes("~"));
	}
});

// 发布是两步提交：先提交代码+版本号，再提交 index.json 指向那个 commit。
// 所以「package.json 比索引新一个版本」是**正常中间态**，不是 bug。
// 这里只允许落后一步；落后两步及以上说明发布流程断了，必须 fail。
function parseVersion(value) {
	return String(value ?? "0.0.0")
		.split(".")
		.map((part) => Number.parseInt(part, 10) || 0);
}

function isPublishPending(indexVersion, packageVersion) {
	const index = parseVersion(indexVersion);
	const pkg = parseVersion(packageVersion);
	if (pkg[0] !== index[0]) return false;
	if (pkg[1] === index[1]) return pkg[2] === index[2] + 1;
	return pkg[1] === index[1] + 1 && pkg[2] === 0;
}

test("索引里的最新版本与 package.json 的 version 一致（允许发布待补的中间态）", () => {
	const newest = versions
		.map((entry) => entry.version)
		.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
	assert.ok(
		newest === manifest.version || isPublishPending(newest, manifest.version),
		`索引最新版本 ${newest} 与 package.json ${manifest.version} 不一致` +
			"（允许的中间态：package.json 比索引新一个版本；落后两步及以上说明发布流程断了）",
	);
});

test("索引里每条版本都带 https 仓库地址", () => {
	for (const version of versions) {
		assert.equal(version.source.type, "git");
		assert.match(version.source.url, /^https:\/\/[^/]+\/[^/]+/u);
	}
});
