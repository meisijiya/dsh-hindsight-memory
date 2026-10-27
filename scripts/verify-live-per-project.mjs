/**
 * per-project 作用域下的活体验证脚本。
 *
 * 验证插件在 `scoping: per-project`（每项目独占一个 bank）下的行为：
 *   1. MCP 握手 + tools/list；
 *   2. retain 落在**该项目的独立 bank**（bank 名 = <base>-<项目名小写>），不是共享库；
 *   3. 其它项目的 bank 里看不到本项目写入的事实（硬隔离负例）；
 *   4. recall 命中本项目 bank；
 *   5. REST 与 MCP 传输行为一致；
 *   6. 清理：把探针事实作废。
 *
 * 用法：node scripts/verify-live-per-project.mjs [apiUrl] [bankBase] [projectLabel]
 *   bankBase  默认 mem；projectLabel 默认 随便问问
 */

import { HindsightMemoryClient } from "../src/client.js";
import { normalizeConfig } from "../src/config.js";
import { SCOPE, TIER } from "../src/parity.js";

const apiUrl = process.argv[2] ?? "http://127.0.0.1:8888";
const bankBase = process.argv[3] ?? "mem";
const label = process.argv[4] ?? "随便问问";
const marker = `PERPROJECT-SELFTEST-${Date.now().toString(36).toUpperCase()}`;
const expectedBank = `${bankBase}-${label.toLowerCase()}`;

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
}

function baseConfig(transport) {
	return normalizeConfig({ apiUrl, bankId: bankBase, bankIdPrefix: "", scoping: "per-project", transport });
}

const listBankFacts = async (bank) => {
	const res = await fetch(
		`${apiUrl}/v1/default/banks/${encodeURIComponent(bank)}/memories/list?limit=300`,
	);
	if (!res.ok) return [];
	const body = await res.json();
	return body?.items ?? body?.memories ?? [];
};

const banks = await (await fetch(`${apiUrl}/v1/default/banks`)).json();
const bankIds = (banks.banks ?? []).map((b) => b.bank_id);
check(
	"目标项目 bank 存在且名为 <base>-<项目名小写>",
	bankIds.includes(expectedBank),
	`expected=${expectedBank} banks=${bankIds.join(",")}`,
);

// ── MCP 传输 ────────────────────────────────────────────────────────────────
const mcp = new HindsightMemoryClient({ config: baseConfig("mcp"), label });
try {
	const status = await mcp.status();
	check("MCP 握手 + tools/list", status.ok === true, `tools=${(status.tools ?? []).join(",")}`);
} catch (error) {
	check("MCP 握手 + tools/list", false, error?.message);
}

check(
	"client 解析出的 bank 名正确",
	mcp.bankId === expectedBank,
	`client.bankId=${mcp.bankId} expected=${expectedBank}`,
);

const mcpClient = new HindsightMemoryClient({ config: baseConfig("mcp"), label });
const mcpProject = await mcpClient.retain({
	content: `${marker} PER-PROJECT 自检事实：本条必须只落在本项目的独立 bank 里。`,
	tier: TIER.PROJECT,
});
console.log(`retain -> ${JSON.stringify(mcpProject).slice(0, 200)}`);

// 服务端抽取是异步的，轮询等 marker 落库。
const WAIT_BUDGET_MS = Number(process.env.HS_VERIFY_WAIT_MS ?? 180_000);
console.log(`等待服务端异步抽取落库（最多 ${Math.round(WAIT_BUDGET_MS / 1000)}s，轮询）…`);
const deadline = Date.now() + WAIT_BUDGET_MS;
let landed = false;
while (Date.now() < deadline) {
	await new Promise((r) => setTimeout(r, 10_000));
	const facts = await listBankFacts(expectedBank);
	if (facts.some((f) => String(f.text ?? "").includes(marker))) { landed = true; break; }
}
check("探针事实落进本项目 bank", landed, `bank=${expectedBank}`);

// 负例：别的项目 bank 里不能出现本项目的探针事实。
const otherBank = bankIds.find((b) => b.startsWith(`${bankBase}-`) && b !== expectedBank);
if (otherBank) {
	const otherFacts = await listBankFacts(otherBank);
	const leaked = otherFacts.filter((f) => String(f.text ?? "").includes(marker));
	check("别的项目 bank 看不到本项目事实（硬隔离负例）", leaked.length === 0, `bank=${otherBank} leaked=${leaked.length}`);
} else {
	check("别的项目 bank 看不到本项目事实（硬隔离负例）", true, "无对照 bank，跳过");
}

// recall 命中
const recalled = await mcpClient.recall({ query: marker, scope: SCOPE.PROJECT, budget: "low" });
check(
	"recall 命中本项目事实",
	recalled.facts.some((f) => String(f.text ?? "").includes(marker)),
	`count=${recalled.facts.length}`,
);

// ── REST 传输 ───────────────────────────────────────────────────────────────
const rest = new HindsightMemoryClient({ config: baseConfig("rest"), label });
try {
	const restStatus = await rest.status();
	check("REST banks 列表", restStatus.ok === true, JSON.stringify(restStatus.banks ?? []).slice(0, 200));
	const restRecall = await rest.recall({ query: marker, scope: SCOPE.PROJECT, budget: "low" });
	check(
		"REST 通道也命中本项目事实",
		restRecall.facts.some((f) => String(f.text ?? "").includes(marker)),
		`count=${restRecall.facts.length}`,
	);
} catch (error) {
	check("REST 通道", false, error?.message);
}

// ── 清理：把探针事实作废 ────────────────────────────────────────────────────
try {
	const facts = await listBankFacts(expectedBank);
	let invalidated = 0;
	for (const f of facts) {
		if (!String(f.text ?? "").includes(marker)) continue;
		const res = await fetch(
			`${apiUrl}/v1/default/banks/${encodeURIComponent(expectedBank)}/memories/${f.id}`,
			{ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "invalidated" }) },
		);
		if (res.ok) invalidated += 1;
	}
	check("探针事实已作废", invalidated > 0, `invalidated=${invalidated}`);
} catch (error) {
	check("探针事实已作废", false, error?.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过，marker=${marker} bank=${expectedBank}`);
process.exit(failed.length === 0 ? 0 : 1);
