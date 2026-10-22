/**
 * 市场索引校验器：index.json 必须满足 DSH 插件市场「格式 1」的宿主契约。
 *
 * 为什么需要它（真实踩过的坑）：
 *   宿主解析器 @deepseek-ai/dsh-plugin-market-index 对 `source.commit` 的要求是
 *   **40 位小写 hex**（`/^[0-9a-f]{40}$/`）。之前 index.json 里写的是 7 位短 sha
 *   （"7eb09bb"）⇒ 整个索引加载失败 ⇒ 插件在「插件 → 发现」里根本不出现，
 *   而且宿主只报一句 "索引加载失败"，非常难查。
 *
 * 校验三层：
 *   1. **宿主解析器**（最高权威）：能解析到 @deepseek-ai/dsh-plugin-market-index 就用它的
 *      parseMarketIndex()，规则跟宿主逐字一致；解析不到就退回第 2 层。
 *   2. **本地格式 1 规则**：内置 format-1 的关键规则（零依赖，可离线跑）。
 *   3. **仓库事实**：每个版本的 commit 必须真实存在于本仓库，且该 commit 上的
 *      package.json 版本号必须与索引里的版本号一致（防止版本号与 commit 对不上）。
 *
 * 用法：
 *   node scripts/validate-market-index.mjs            # 校验并打印逐项结果
 *   node scripts/validate-market-index.mjs --json     # 机器可读输出
 */

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(repoRoot, "index.json");
const asJson = process.argv.includes("--json");

const results = [];
/**
 * 记录一条校验结论。
 * @param {string} name 校验项名称。
 * @param {"pass"|"fail"|"skip"} status 结论。
 * @param {string} [detail] 补充说明。
 */
function check(name, status, detail) {
	results.push({ name, status, detail });
	if (!asJson) {
		const tag = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL";
		console.log(`${tag} | ${name}${detail ? ` | ${detail}` : ""}`);
	}
}

// ── 宿主解析器定位 ────────────────────────────────────────────────────────────

/**
 * 归一化候选根目录：Git Bash 会把 PATH 写成 `/d/dev/...` 这种 Unix 形式，
 * 而 Windows 上的 node 无法直接用它 ⇒ 把 `/x/...` 映射回 `X:/...`。
 * @param {string} root 原始路径。
 * @returns {string} 可用的绝对路径。
 */
function normalizeRoot(root) {
	if (process.platform !== "win32") return root;
	const unixDrive = /^\/([a-zA-Z])\//.exec(root);
	if (!unixDrive) return root;
	const rest = root.slice(3).replaceAll("/", path.sep);
	return `${unixDrive[1].toUpperCase()}:${path.sep}${rest}`;
}

/**
 * 候选安装根目录：PATH 里的每个条目、全局 npm 目录、pnpm 全局目录、各 profile。
 * @returns {string[]} 绝对路径列表。
 */
function candidateRoots() {
	const roots = new Set();
	const push = (value) => {
		if (value) roots.add(normalizeRoot(value));
	};
	for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
		if (entry) push(entry);
	}
	const home = os.homedir();
	push(process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules") : "");
	push(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "pnpm", "global", "5", "node_modules") : "");
	push(path.join(home, ".dsh", "profiles"));
	return [...roots];
}

/**
 * 找到宿主解析器包的位置。
 *
 * 宿主解析器装在 DSH 本体的依赖树里（`<全局根>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/…`），
 * 插件自己装在 profile 里，两棵树不通 ⇒ 必须按「全局根 + profile 根」分别去找。
 * @returns {string|null} 包目录，找不到返回 null。
 */
function findHostParserDir() {
	const relative = path.join("@deepseek-ai", "dsh-plugin-market-index");
	const roots = candidateRoots();
	for (const root of roots) {
		const candidates = [
			path.join(root, relative),
			path.join(root, "node_modules", relative),
			// DSH 本体的依赖树：…/@deepseek-ai/dsh/node_modules/@deepseek-ai/…
			path.join(root, "node_modules", "@deepseek-ai", "dsh", "node_modules", relative),
		];
		for (const candidate of candidates) {
			if (existsSync(path.join(candidate, "package.json"))) return candidate;
		}
		// 再扫一层：…/node_modules/@deepseek-ai/<任意包>/node_modules/@deepseek-ai/…
		const scopeDir = path.join(root, "node_modules", "@deepseek-ai");
		if (!existsSync(scopeDir)) continue;
		for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const nested = path.join(scopeDir, entry.name, "node_modules", relative);
			if (existsSync(path.join(nested, "package.json"))) return nested;
		}
	}
	// 本仓库自己的 devDependency
	const local = path.join(repoRoot, "node_modules", relative);
	if (existsSync(path.join(local, "package.json"))) return local;
	return null;
}

// ── 第 2 层：本地格式 1 规则（零依赖） ────────────────────────────────────────

const SEMVER_EXACT = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;

/**
 * 本地复刻 format-1 的关键规则。
 * @param {unknown} value 解析后的 JSON。
 * @param {string} indexUrl 索引 URL（相对引用按它解析）。
 * @returns {string[]} 违规描述，空数组表示通过。
 */
function localFormatViolations(value, indexUrl) {
	const problems = [];
	const at = (pathExpr, reason) => problems.push(`${pathExpr} ${reason}`);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		at("$", "must be an object");
		return problems;
	}
	const object = /** @type {Record<string, any>} */ (value);
	if (object.format !== 1) at("$.format", "must be 1");
	const localized = (member, pathExpr) => {
		if (typeof member === "string") return member.trim() === "" ? at(pathExpr, "must not be empty") : undefined;
		if (typeof member !== "object" || member === null) {
			at(pathExpr, "must be a string or a language map");
			return undefined;
		}
		for (const [language, text] of Object.entries(member)) {
			if (!LANGUAGE_ID.test(language)) at(`${pathExpr}.${language}`, "must be a lowercase language id");
			if (typeof text !== "string" || text.trim() === "") at(`${pathExpr}.${language}`, "must be a non-empty string");
		}
		if (!Object.hasOwn(member, "en")) at(pathExpr, "must contain en");
		return undefined;
	};
	localized(object.title, "$.title");
	localized(object.description, "$.description");
	const categories = object.metadata?.categories ?? {};
	const plugins = object.plugins;
	if (!Array.isArray(plugins)) {
		at("$.plugins", "must be an array");
		return problems;
	}
	const names = new Set();
	plugins.forEach((plugin, position) => {
		const base = `$.plugins[${String(position)}]`;
		if (typeof plugin !== "object" || plugin === null) {
			at(base, "must be an object");
			return;
		}
		if (typeof plugin.name !== "string" || !PACKAGE_NAME.test(plugin.name)) at(`${base}.name`, "must be a valid npm package name");
		if (names.has(plugin.name)) at(`${base}.name`, `duplicates ${plugin.name}`);
		names.add(plugin.name);
		localized(plugin.title, `${base}.title`);
		localized(plugin.description, `${base}.description`);
		const category = plugin.metadata?.category;
		if (category !== undefined && !Object.hasOwn(categories, category)) {
			at(`${base}.metadata.category`, `references undeclared id ${JSON.stringify(category)}`);
		}
		const versions = plugin.versions;
		if (!Array.isArray(versions) || versions.length === 0) {
			at(`${base}.versions`, "must be a non-empty array");
			return;
		}
		const seen = new Set();
		for (const [offset, version] of versions.entries()) {
			const versionPath = `${base}.versions[${String(offset)}]`;
			if (typeof version !== "object" || version === null) {
				at(versionPath, "must be an object");
				continue;
			}
			if (typeof version.version !== "string" || !SEMVER_EXACT.test(version.version)) {
				at(`${versionPath}.version`, "must be an exact SemVer version");
			}
			if (seen.has(version.version)) at(`${versionPath}.version`, `duplicates ${version.version}`);
			seen.add(version.version);
			const stamp = version.publishTimestamp;
			if (typeof stamp !== "number" || !Number.isInteger(stamp) || stamp < 0 || stamp >= 1e11) {
				at(`${versionPath}.publishTimestamp`, "must be an integer number of Unix seconds in [0, 10^11)");
			}
			const source = version.source;
			if (typeof source !== "object" || source === null) {
				at(`${versionPath}.source`, "must be an object");
				continue;
			}
			if (source.type === "git") {
				if (typeof source.url !== "string" || !source.url.startsWith("https://")) {
					at(`${versionPath}.source.url`, "must be an https URL");
				} else {
					const url = new URL(source.url);
					if (url.href !== source.url) at(`${versionPath}.source.url`, "must be a canonical URL");
					if (!/^(?:\/[^/]+){2,}$/u.test(url.pathname)) {
						at(`${versionPath}.source.url`, "must name a repository with at least two path segments");
					}
				}
				if (typeof source.commit !== "string" || !COMMIT_SHA.test(source.commit)) {
					at(`${versionPath}.source.commit`, "must be a lowercase 40-hex-digit commit SHA");
				}
			} else if (source.type !== "npm") {
				at(`${versionPath}.source.type`, 'must be "npm" or "git"');
			}
			const range = version.engines?.dsh;
			if (range !== undefined && (typeof range !== "string" || !range.includes("."))) {
				at(`${versionPath}.engines.dsh`, "must be a SemVer range");
			}
		}
	});
	void indexUrl;
	return problems;
}

// ── 第 3 层：仓库事实（git） ────────────────────────────────────────────────

const tmpDir = existsSync(path.join(repoRoot, ".git")) ? path.join(repoRoot, ".git") : repoRoot;

/**
 * 调用 git。
 *
 * 沙箱里进程 spawn 带 pipe 会被拒（EPERM：命名管道不可用），所以 stdout/stderr
 * 改写到工作区内的临时文件，再用文件读回来 —— 文件描述符不是管道，约束模式放行。
 * @param {string[]} args git 参数。
 * @returns {{status: number|null, output: string}} status 为退出码；null 表示 git 根本跑不起来。
 */
function git(args) {
	const outFile = path.join(tmpDir, "validate-market-index.out");
	let fd;
	try {
		fd = openSync(outFile, "w");
	} catch {
		return { status: null, output: "" };
	}
	try {
		execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", fd, fd] });
		return { status: 0, output: readFileSync(outFile, "utf8") };
	} catch (error) {
		const status = typeof error?.status === "number" ? error.status : null;
		let output = "";
		try {
			output = readFileSync(outFile, "utf8");
		} catch {
			// 读不到就当空输出
		}
		return { status, output };
	} finally {
		try {
			closeSync(fd);
		} catch {
			// 已关闭
		}
		try {
			unlinkSync(outFile);
		} catch {
			// 清理失败不影响结论
		}
	}
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

const raw = readFileSync(indexPath, "utf8");
let document;
try {
	document = JSON.parse(raw);
} catch (error) {
	check("index.json 是合法 JSON", "fail", error?.message);
	if (asJson) console.log(JSON.stringify({ ok: false, results }, null, 2));
	process.exit(1);
}
check("index.json 是合法 JSON", "pass");

// 1) 宿主解析器
const indexUrl = "https://raw.githubusercontent.com/meisijiya/dsh-hindsight-memory/main/index.json";
const parserDir = findHostParserDir();
let hostParser = null;
if (parserDir) {
	try {
		// Windows 上动态 import 必须是 file:// URL，直接给绝对路径会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME。
		hostParser = await import(pathToFileURL(path.join(parserDir, "lib", "index.js")).href);
	} catch {
		hostParser = null;
	}
}
if (hostParser?.parseMarketIndex) {
	try {
		const parsed = hostParser.parseMarketIndex(document, indexUrl);
		check(
			"宿主 parseMarketIndex 校验通过",
			"pass",
			`parser=${path.relative(repoRoot, parserDir).replaceAll("\\", "/")} · plugins=${parsed.plugins.length}`,
		);
	} catch (error) {
		check("宿主 parseMarketIndex 校验通过", "fail", `${error?.path ?? "$"} ${error?.reason ?? error?.message}`);
	}
} else {
	check(
		"宿主 parseMarketIndex 校验通过",
		"skip",
		parserDir
			? `找到 ${parserDir} 但导入失败，只跑了本地规则`
			: "未找到 @deepseek-ai/dsh-plugin-market-index，只跑了本地规则",
	);
}

// 2) 本地规则
const violations = localFormatViolations(document, indexUrl);
check("本地 format-1 规则校验通过", violations.length === 0 ? "pass" : "fail", violations.join("; ") || undefined);

// 3) 仓库事实
const plugin = document.plugins?.find?.((entry) => entry?.name === "dsh-hindsight-memory");
const currentVersion = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
if (!plugin) {
	check("索引包含本插件", "fail", "没有找到 name=dsh-hindsight-memory");
} else {
	check("索引包含本插件", "pass");
	const versions = plugin.versions ?? [];
	const newest = versions.reduce((left, right) => {
		const a = left?.version ?? "0.0.0";
		const b = right?.version ?? "0.0.0";
		return a.localeCompare(b, undefined, { numeric: true }) >= 0 ? left : right;
	}, versions[0]);
	// 发布是两步提交（代码+版本号 → index.json 指向那个 commit），
	// 「package.json 比索引新一个版本」是正常中间态；落后两步及以上则为 fail。
	const isPublishPending = (indexVersion, packageVersion) => {
		const index = String(indexVersion ?? "0.0.0").split(".").map((part) => Number.parseInt(part, 10) || 0);
		const pkg = String(packageVersion ?? "0.0.0").split(".").map((part) => Number.parseInt(part, 10) || 0);
		if (pkg[0] !== index[0]) return false;
		if (pkg[1] === index[1]) return pkg[2] === index[2] + 1;
		return pkg[1] === index[1] + 1 && pkg[2] === 0;
	};
	check(
		"索引最新版本与 package.json 一致（允许发布待补的中间态）",
		newest?.version === currentVersion || isPublishPending(newest?.version, currentVersion)
			? "pass"
			: "fail",
		`index=${newest?.version} package.json=${currentVersion}`,
	);
	for (const version of versions) {
		const commit = version.source?.commit;
		if (typeof commit !== "string" || !COMMIT_SHA.test(commit)) {
			check(`版本 ${version.version} 的 commit 是 40 位 hex`, "fail", String(commit));
			continue;
		}
		check(`版本 ${version.version} 的 commit 是 40 位 hex`, "pass", commit.slice(0, 8));
		const exists = git(["cat-file", "-e", `${commit}^{commit}`]);
		if (exists.status === null) {
			check(`版本 ${version.version} 的 commit 在本仓库存在`, "skip", "git 不可用（沙箱限制）");
			continue;
		}
		if (exists.status !== 0) {
			check(`版本 ${version.version} 的 commit 在本仓库存在`, "fail", "本仓库没有这个 commit");
			continue;
		}
		check(`版本 ${version.version} 的 commit 在本仓库存在`, "pass");
		const manifest = git(["show", `${commit}:package.json`]);
		if (manifest.status === null) {
			check(`版本 ${version.version} 的 commit 上 package.json 版本一致`, "skip", "git 不可用（沙箱限制）");
			continue;
		}
		if (manifest.status !== 0) {
			check(`版本 ${version.version} 的 commit 上 package.json 版本一致`, "fail", "该 commit 上读不到 package.json");
			continue;
		}
		let declared;
		try {
			declared = JSON.parse(manifest.output).version;
		} catch {
			check(`版本 ${version.version} 的 commit 上 package.json 版本一致`, "fail", "package.json 解析失败");
			continue;
		}
		check(
			`版本 ${version.version} 的 commit 上 package.json 版本一致`,
			declared === version.version ? "pass" : "fail",
			`commit 上是 ${declared}`,
		);
	}
}

// 防呆：工作区的 package.json 必须与 HEAD 提交里的**内容**一致。
// 背景：文件编辑工具会保留 mtime，而「0.6.2 → 0.6.3」这类改动**字节数不变**，
// 于是 git 的 stat 缓存认为文件没动过，`git add -A` 静默沿用旧 blob ——
// 版本号就这么被吞掉，市场索引指向一个版本号不符的 commit（v0.6.3 实踩）。
// 用 `git hash-object` 强制读内容比对，不依赖 stat 缓存。
{
	const workBlob = git(["hash-object", "--path=package.json", "package.json"]);
	const headBlob = git(["rev-parse", "HEAD:package.json"]);
	if (workBlob.status === null || headBlob.status === null) {
		check("工作区 package.json 内容与 HEAD 一致", "skip", "git 不可用（沙箱限制）");
	} else if (workBlob.status !== 0 || headBlob.status !== 0) {
		check("工作区 package.json 内容与 HEAD 一致", "fail", "读不到 package.json 或 HEAD 上没有该文件");
	} else {
		const work = workBlob.output.trim();
		const head = headBlob.output.trim();
		check(
			"工作区 package.json 内容与 HEAD 一致",
			work === head ? "pass" : "fail",
			work === head ? "一致" : "工作区有未提交改动（或被 stat 缓存吞掉）",
		);
	}
}

const failed = results.filter((entry) => entry.status === "fail");
if (asJson) {
	console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
} else {
	console.log(`\n${failed.length === 0 ? "OK" : "FAILED"} · ${results.filter((r) => r.status === "pass").length} pass / ${results.filter((r) => r.status === "skip").length} skip / ${failed.length} fail`);
}
process.exit(failed.length === 0 ? 0 : 1);
