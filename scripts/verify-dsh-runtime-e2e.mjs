/**
 * DSH 端到端验证：确认「DSH 侧配置」与「插件代码」落在**同一个 bank**上，
 * 再走 MCP 传输做一次真实写入 + 跨 bank 硬隔离负例。
 *
 * 🔴 运行时真源是**插件包内默认值**（src/config.js 的 DEFAULTS）：
 * 实测 2026-10-28，DSH 没有把行配置投递给本插件 —— 改 profile 的
 * cordis.patch.yml 与插件自带的 cordis.patch.yml 都不改变运行时行为。
 * 因此本脚本用插件默认值建 client，并额外断言「宿主合成配置 == 插件默认值」，
 * 这样无论宿主将来是否投递配置，跑出来的 bank 都一致。
 *
 * 用法：node scripts/verify-dsh-runtime-e2e.mjs [apiUrl] [projectLabel]
 */
import { execFileSync } from "node:child_process";
import { HindsightMemoryClient } from "../src/client.js";
import { normalizeConfig } from "../src/config.js";
import { SCOPE, TIER } from "../src/parity.js";

const apiUrl = process.argv[2] ?? "http://127.0.0.1:8888";
const label = process.argv[3] ?? "随便问问";
const marker = `DSHE2E-${Date.now().toString(36).toUpperCase()}`;

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
}

// ── 1. 取 DSH 真实合成配置 ──────────────────────────────────────────────────
// Windows 上 dsh 是 .cmd 包装器，spawnSync 需要 shell 或显式路径。
const DSH = process.env.DSH_BIN ?? "dsh";
let dump;
try {
	dump = execFileSync(DSH, ["--profile", "web", "--dump-config"], {
		encoding: "utf8",
		shell: process.platform === "win32",
	});
} catch (error) {
	console.log("FAIL | dsh --dump-config 执行失败 |", error?.message);
	process.exit(1);
}
// dump 是 YAML：找 `hindsight-memory` 条目的 config 块
const lines = dump.split(/\r?\n/);
let inBlock = false, inConfig = false, cfg = null;
for (const line of lines) {
	if (/^- id: hindsight-memory\s*$/.test(line)) { inBlock = true; inConfig = false; continue; }
	if (inBlock && /^- id: /.test(line)) break;
	if (!inBlock) continue;
	if (/^\s{2}config:\s*$/.test(line)) { inConfig = true; continue; }
	if (inConfig) {
		const m = line.match(/^ {4}([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
		if (!m) { if (line.trim() === "") continue; break; }
		let v = m[2].trim();
		const quoted = /^(['"])(.*)\1$/.exec(v);
		if (quoted) v = quoted[2];
		else if (v === "true") v = true;
		else if (v === "false") v = false;
		else if (v === "null" || v === "~" || v === "") v = null;
		cfg ??= {};
		cfg[m[1]] = v;
	}
}
check("从 dsh --dump-config 取到 hindsight-memory 配置", !!cfg && !!cfg.bankId && !!cfg.scoping,
	JSON.stringify(cfg ?? null));

if (!cfg) process.exit(1);

// 🔴 实测（2026-10-28）：DSH 运行时**没有把行配置投递给本插件** ——
// 改 profile 的 cordis.patch.yml 与插件自带的 cordis.patch.yml 都不生效，
// 只有 src/config.js 的 DEFAULTS 会改变运行时行为。
// 所以这里以「插件包内默认值」为运行时真源，并要求宿主配置与它一致：
// 两边一致时，无论宿主将来是否投递配置，跑出来的 bank 都一样。
const runtimeConfig = normalizeConfig({});
check(
	"插件包内默认配置 = per-project",
	runtimeConfig.scoping === "per-project",
	`scoping=${runtimeConfig.scoping}`,
);
check(
	"插件包内默认配置 = bankId mem",
	runtimeConfig.bankId === "mem",
	`bankId=${runtimeConfig.bankId}`,
);
check(
	"宿主合成配置与插件默认配置一致（bankId/scoping/精神模型前缀）",
	cfg.bankId === runtimeConfig.bankId &&
		cfg.scoping === runtimeConfig.scoping &&
		(cfg.mentalModelPrefix ?? "") === runtimeConfig.mentalModelPrefix,
	`host=${JSON.stringify({ bankId: cfg.bankId, scoping: cfg.scoping, mentalModelPrefix: cfg.mentalModelPrefix })} plugin=${JSON.stringify({ bankId: runtimeConfig.bankId, scoping: runtimeConfig.scoping, mentalModelPrefix: runtimeConfig.mentalModelPrefix })}`,
);

// ── 2. 喂给插件自己的配置归一化 + client ───────────────────────────────────
const pluginConfig = normalizeConfig({ apiUrl });
const client = new HindsightMemoryClient({ config: pluginConfig, label });
const expectedBank = `${pluginConfig.bankId}-${label.toLowerCase()}`;
check("插件解析出的 bank 名正确", client.bankId === expectedBank, `client.bankId=${client.bankId}`);

const banks = await (await fetch(`${apiUrl}/v1/default/banks`)).json();
const bankIds = (banks.banks ?? []).map((b) => b.bank_id);
check("目标 bank 存在", bankIds.includes(expectedBank), `expected=${expectedBank}`);

// ── 3. 真实写入 ─────────────────────────────────────────────────────────────
const retainResult = await client.retain({
	content: `${marker} DSH 运行时端到端自检事实：本条必须落在 ${expectedBank}，其它 bank 看不到。`,
	tier: TIER.PROJECT,
});
check("retain 被接受", !!retainResult?.result, JSON.stringify(retainResult).slice(0, 160));

const listFacts = async (bank, state) => {
	const url = new URL(`${apiUrl}/v1/default/banks/${encodeURIComponent(bank)}/memories/list`);
	url.searchParams.set("limit", "300");
	// consolidation 会把被合并的原始事实置为 invalidated（服务端自动巩固的正常行为），
	// 所以探针可能落在 valid 或 invalidated 两种状态里，两个都要看。
	if (state) url.searchParams.set("state", state);
	const res = await fetch(url);
	if (!res.ok) return [];
	const body = await res.json();
	return body?.items ?? body?.memories ?? [];
};
const findProbe = async (bank) => {
	const live = await listFacts(bank);
	if (live.some((f) => String(f.text ?? "").includes(marker))) return true;
	const archived = await listFacts(bank, "invalidated");
	return archived.some((f) => String(f.text ?? "").includes(marker));
};

const deadline = Date.now() + 180_000;
let landed = false;
while (Date.now() < deadline) {
	await new Promise((r) => setTimeout(r, 10_000));
	if (await findProbe(expectedBank)) { landed = true; break; }
}
check("探针事实落进 DSH 解析出的 bank", landed, `bank=${expectedBank}`);

const otherBank = bankIds.find((b) => b.startsWith(`${pluginConfig.bankId}-`) && b !== expectedBank);
if (otherBank) {
	const leaked = [
		...(await listFacts(otherBank)),
		...(await listFacts(otherBank, "invalidated")),
	].filter((f) => String(f.text ?? "").includes(marker));
	check("其它项目 bank 看不到（硬隔离负例）", leaked.length === 0, `bank=${otherBank} leaked=${leaked.length}`);
} else {
	check("其它项目 bank 看不到（硬隔离负例）", true, "无对照 bank，跳过");
}

const recalled = await client.recall({ query: marker, scope: SCOPE.PROJECT, budget: "low" });
// 探针可能已被 consolidation 合并成 observation（原始事实自动 invalidated），
// 召回结果里出现 marker 就算命中（valid world / observation 任一）。
check(
	"recall 命中",
	recalled.facts.some((f) => String(f.text ?? "").includes(marker)),
	`count=${recalled.facts.length}`,
);

// ── 4. 清理 ────────────────────────────────────────────────────────────────
// 探针可能已被 consolidation 合并成 observation（原始事实自动置 invalidated），
// 两种状态都要清理，否则会留下垃圾事实。
let invalidated = 0;
for (const state of [undefined, "invalidated"]) {
	for (const f of await listFacts(expectedBank, state)) {
		if (!String(f.text ?? "").includes(marker)) continue;
		const res = await fetch(
			`${apiUrl}/v1/default/banks/${encodeURIComponent(expectedBank)}/memories/${f.id}`,
			{ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "invalidated" }) },
		);
		if (res.ok) invalidated += 1;
	}
}
check("探针事实已作废", invalidated > 0, `invalidated=${invalidated}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过，marker=${marker} bank=${expectedBank}`);
process.exit(failed.length === 0 ? 0 : 1);
