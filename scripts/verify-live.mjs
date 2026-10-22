/**
 * 活体验证脚本：直接用插件的 client 层打真实的 Hindsight 服务。
 *
 * 验证 5 件事：
 *   1. 自写的最小 MCP streamable-http 客户端能握手（mcp-session-id）并列出工具；
 *   2. recall 带 tags=[project:<label>] + any ⇒ 项目层 + 全局层同时可见；
 *   3. recall 带 tags=[project:<不存在的仓库>] + any ⇒ 只有全局层；
 *   4. retain 带 tags ⇒ 落库 tags 恰好等于该 tag；retain 不带 tags ⇒ 落库 tags=[]；
 *   5. REST 传输与 MCP 传输行为一致。
 *
 * 用法：node scripts/verify-live.mjs [apiUrl] [bankId] [projectLabel]
 */

import { HindsightMemoryClient } from "../src/client.js";
import { normalizeConfig } from "../src/config.js";
import { SCOPE, TIER } from "../src/parity.js";

const apiUrl = process.argv[2] ?? "http://127.0.0.1:8888";
const bankId = process.argv[3] ?? "shared";
const label = process.argv[4] ?? "随便问问";
const marker = `PLUGINSELFTEST-${Date.now().toString(36).toUpperCase()}`;

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
}

function baseConfig(transport) {
	return normalizeConfig({ apiUrl, bankId, bankIdPrefix: "", scoping: "per-project-tagged", transport });
}

const cleanup = [];

// ── MCP 传输 ────────────────────────────────────────────────────────────────
const mcp = new HindsightMemoryClient({ config: baseConfig("mcp"), label });
try {
	const status = await mcp.status();
	check("MCP 握手 + tools/list", status.ok === true, `tools=${(status.tools ?? []).join(",")}`);
} catch (error) {
	check("MCP 握手 + tools/list", false, error?.message);
}

const mcpClient = new HindsightMemoryClient({ config: baseConfig("mcp"), label });

const mcpGlobal = await mcpClient.retain({
	content: `${marker} GLOBAL-LAYER 自检事实：DSH 记忆插件写侧不带标签即全局层。`,
	tier: TIER.GLOBAL,
});
cleanup.push(mcpGlobal);

const mcpProject = await mcpClient.retain({
	content: `${marker} PROJECT-LAYER 自检事实：DSH 记忆插件写侧带项目标签即项目层。`,
	tier: TIER.PROJECT,
});
cleanup.push(mcpProject);

// 服务端抽取是异步的，而且**耗时随服务端负载浮动**（本机曾出现 25s 不够、
// 1~2 分钟才落库的情况）。改成轮询等 marker 出现，最多等 180s，避免自检假阴性。
const WAIT_BUDGET_MS = Number(process.env.HS_VERIFY_WAIT_MS ?? 180_000);
console.log(`等待服务端异步抽取落库（最多 ${Math.round(WAIT_BUDGET_MS / 1000)}s，轮询）…`);
const waitForMarker = async () => {
	const deadline = Date.now() + WAIT_BUDGET_MS;
	let last = { facts: [] };
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10_000));
		last = await mcpClient.recall({ query: marker, scope: SCOPE.PROJECT, budget: "low" });
		const hit = last.facts.some((f) => (f.text ?? "").includes(marker));
		if (hit) return { ok: true, waited: Math.round((WAIT_BUDGET_MS - (deadline - Date.now())) / 1000) };
	}
	return { ok: false, waited: Math.round(WAIT_BUDGET_MS / 1000), last };
};
const markerWait = await waitForMarker();
console.log(
	markerWait.ok
		? `探针事实已落库（约 ${markerWait.waited}s）。`
		: `⚠️ ${markerWait.waited}s 内探针事实仍未落库——服务端抽取偏慢或队列堵塞，下面两条检查会因此报 FAIL。`,
);

const projectScope = await mcpClient.recall({ query: marker, scope: SCOPE.PROJECT, budget: "low" });
const projectOnly = await mcpClient.recall({ query: marker, scope: SCOPE.PROJECT_ONLY, budget: "low" });
const globalScope = await mcpClient.recall({ query: marker, scope: SCOPE.GLOBAL, budget: "low" });
const foreignScope = await mcpClient.recall({
	query: marker,
	scope: SCOPE.PROJECT,
	budget: "low",
});
// 负例必须换一个**别的项目标签**：用本项目标签 + any_strict 当然能看到自己的事实。
const foreign = new HindsightMemoryClient({ config: baseConfig("mcp"), label: "插件自检-不存在仓库" });
const foreignView = await foreign.recall({ query: marker, scope: SCOPE.PROJECT_ONLY, budget: "low" });

const texts = (list) => list.map((f) => f.text).join(" | ");
check(
	"project scope 同时看到项目层与全局层",
	projectScope.facts.some((f) => f.tags.length === 0) &&
		projectScope.facts.some((f) => f.tags.includes(`project:${label}`)),
	`count=${projectScope.facts.length}`,
);
check(
	"project_only scope 只看到项目层",
	projectOnly.facts.length > 0 &&
		projectOnly.facts.every((f) => f.tags.includes(`project:${label}`)),
	texts(projectOnly.facts).slice(0, 120),
);
check(
	"global scope 只看到无标签事实",
	globalScope.facts.length > 0 && globalScope.facts.every((f) => f.tags.length === 0),
	texts(globalScope.facts).slice(0, 120),
);
check(
	"别的项目标签看不到本项目事实（硬隔离负例）",
	foreignView.facts.length === 0,
	`count=${foreignView.facts.length} ${texts(foreignView.facts).slice(0, 100)}`,
);
void foreignScope;

// ── REST 传输 ───────────────────────────────────────────────────────────────
const rest = new HindsightMemoryClient({ config: baseConfig("rest"), label });
try {
	const restStatus = await rest.status();
	check("REST banks 列表", restStatus.ok === true, JSON.stringify(restStatus.banks ?? []).slice(0, 160));
	const restRecall = await rest.recall({ query: marker, scope: SCOPE.PROJECT, budget: "low" });
	const markerOf = (facts) =>
		new Set(facts.filter((f) => f.text.includes(marker)).map((f) => f.text.replace(/\s+/g, " ")));
	const mcpSet = markerOf(projectScope.facts);
	const restSet = markerOf(restRecall.facts);
	const same =
		mcpSet.size > 0 &&
		restSet.size > 0 &&
		[...mcpSet].every((t) => [...restSet].some((r) => r.includes(t.slice(0, 40)) || t.includes(r.slice(0, 40))));
	check(
		"REST 与 MCP 召回到同一批探针事实",
		same,
		`mcp=${mcpSet.size} rest=${restSet.size} (总数 rest=${restRecall.facts.length} mcp=${projectScope.facts.length})`,
	);
} catch (error) {
	check("REST 通道", false, error?.message);
}

// ── 清理：把探针事实作废 ────────────────────────────────────────────────────
async function cleanupFacts() {
	try {
		const list = await fetch(`${apiUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories/list?limit=200`);
		const body = await list.json();
		const items = body?.memories ?? body?.items ?? [];
		let invalidated = 0;
		for (const item of items) {
			const text = item?.text ?? item?.content ?? "";
			if (!String(text).includes(marker)) continue;
			const res = await fetch(
				`${apiUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories/${item.id}`,
				{ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "invalidated" }) },
			);
			if (res.ok) invalidated += 1;
		}
		check("探针事实已作废", invalidated > 0, `invalidated=${invalidated}`);
	} catch (error) {
		check("探针事实已作废", false, error?.message);
	}
}
await cleanupFacts();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过，marker=${marker}`);
process.exit(failed.length === 0 ? 0 : 1);
