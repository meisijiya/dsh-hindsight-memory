/**
 * DSH 端到端验证：从 `dsh --profile web --dump-config` 的**真实合成输出**里取出
 * hindsight-memory 的 config，喂给插件自己的 normalizeConfig + HindsightMemoryClient，
 * 走 MCP 传输做一次真实写入，再做跨 bank 硬隔离负例。
 *
 * 这一步验证的是「DSH 运行时配置 → 插件代码 → 服务端落库位置」整条链路，
 * 而不是手工构造 config。
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
		let v = m[2].trim().replace(/^['"]|['"]$/g, "");
		if (v === "true") v = true;
		else if (v === "false") v = false;
		else if (v === "null" || v === "~" || v === "") v = null;
		cfg ??= {};
		cfg[m[1]] = v;
	}
}
check("从 dsh --dump-config 取到 hindsight-memory 配置", !!cfg && !!cfg.bankId && !!cfg.scoping,
	JSON.stringify(cfg ?? null));

if (!cfg) process.exit(1);
check("DSH 合成配置的 scoping 是 per-project", cfg.scoping === "per-project", `scoping=${cfg.scoping}`);
check("DSH 合成配置的 bankId 是 mem", cfg.bankId === "mem", `bankId=${cfg.bankId}`);

// ── 2. 喂给插件自己的配置归一化 + client ───────────────────────────────────
const pluginConfig = normalizeConfig({ ...cfg, apiUrl });
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
