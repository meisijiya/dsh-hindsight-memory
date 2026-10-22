#!/usr/bin/env node
/**
 * 隔离观测（isolation observation）。
 *
 * 目的：用**两个项目目录** + 一条**全局层**事实，实测「单 bank + 双层标签」的分层可见性矩阵：
 *   - 项目 A 的记忆：只有 A 看得见；
 *   - 全局层记忆：A、B 都看得见；
 *   - 项目 B 的记忆：只有 B 看得见。
 *
 * 走的是插件自己的模块（src/client.js + src/parity.js），即 DSH 侧真实读写路径；
 * 结论只认服务端返回的原始事实（REST /memories/list + recall results），不采信模型自述。
 *
 * 用法：
 *   node scripts/isolation-check.mjs                       # 默认 A=本仓库 B=D:/26code/测试hindsight
 *   node scripts/isolation-check.mjs --a "D:/x" --b "D:/y" # 指定两个项目目录
 *   node scripts/isolation-check.mjs --keep                # 保留探针事实（默认观测后作废）
 */
import { HindsightMemoryClient } from "../src/client.js";
import { normalizeConfig } from "../src/config.js";
import { resolveProjectLabel } from "../src/label.js";
import { PROJECT_TAG_PREFIX, SCOPE, TIER } from "../src/parity.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const keep = args.includes("--keep");

const dirA = flag("--a", "D:/26code/随便问问");
const dirB = flag("--b", "D:/26code/测试hindsight");
const stamp = Date.now().toString(36).toUpperCase().slice(-6);
const MARK = { A: `ISOMARKA${stamp}`, B: `ISOMARKB${stamp}`, G: `ISOMARKG${stamp}` };
const ALL_MARKS = Object.values(MARK);

const config = normalizeConfig({});
const labelA = await resolveProjectLabel(dirA);
const labelB = await resolveProjectLabel(dirB);
const clientA = new HindsightMemoryClient({ config, label: labelA });
const clientB = new HindsightMemoryClient({ config, label: labelB });
const bank = clientA.bankId;

const line = (s = "") => console.log(s);
const rest = async (path, init) => {
	const res = await fetch(`${config.apiUrl}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
	return res.status === 204 ? null : res.json();
};
const listFacts = async () => {
	const data = await rest(`/v1/default/banks/${encodeURIComponent(bank)}/memories/list?limit=500`).catch(() => []);
	return data?.memories ?? data?.items ?? (Array.isArray(data) ? data : []);
};
const textOf = (f) => f?.text ?? f?.content ?? "";
const marked = (f) => ALL_MARKS.find((m) => textOf(f).includes(m)) ?? null;

line(`配置  bank=${bank}  scoping=${config.scoping}  transport=${config.transport}`);
line(`项目A  ${dirA}  → label=${labelA}`);
line(`项目B  ${dirB}  → label=${labelB}`);
line(`探针    A=${MARK.A}  B=${MARK.B}  G=${MARK.G}`);
line("");

// ── 写入：项目A 事实 / 项目B 事实 / 全局层事实 ──────────────────────────
line("写入三条探针事实（抽取是异步的，需要等待落库）…");
await clientA.retain({ content: `${MARK.A} 项目A(${labelA}) 专属事实：只有项目A应当看得到这条。`, tier: TIER.PROJECT });
await clientB.retain({ content: `${MARK.B} 项目B(${labelB}) 专属事实：只有项目B应当看得到这条。`, tier: TIER.PROJECT });
await clientA.retain({ content: `${MARK.G} 全局层事实：两个项目都应当看得到这条。`, tier: TIER.GLOBAL });

/** 轮询 /memories/list 直到三条探针都落库（抽取完成后才出现）。 */
async function waitForProbes() {
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		const facts = await listFacts();
		const hit = new Set(facts.map(marked).filter(Boolean));
		if (hit.size >= 3) return hit;
		await new Promise((r) => setTimeout(r, 4000));
	}
	return new Set();
}

const landed = await waitForProbes();
line(landed.size >= 3 ? `✔ 三条探针已落库（${landed.size}/3）` : `⚠️ 180s 内只落库 ${landed.size}/3 条，继续观测`);
line("");

// ── 观测：可见性矩阵 ────────────────────────────────────────────────────
const probeHits = (facts) => {
	const hits = new Set();
	for (const f of facts) {
		const m = marked(f);
		if (m) hits.add(m);
	}
	return hits;
};

const rows = [];
for (const [who, client] of [
	["项目A", clientA],
	["项目B", clientB],
]) {
	for (const [scopeName, scope] of [
		["project(项目层+全局层)", SCOPE.PROJECT],
		["project_only(仅项目层)", SCOPE.PROJECT_ONLY],
		["global(仅全局层)", SCOPE.GLOBAL],
	]) {
		const { facts } = await client.recall({ query: `ISOMARK ${stamp} 隔离分层观测`, scope, budget: "high" });
		const hits = probeHits(facts);
		rows.push({
			观察者: who,
			scope: scopeName,
			"A层": hits.has(MARK.A) ? "可见" : "不可见",
			"B层": hits.has(MARK.B) ? "可见" : "不可见",
			全局层: hits.has(MARK.G) ? "可见" : "不可见",
			命中: [...hits].join(",") || "（无）",
		});
	}
}

line("可见性矩阵（只看探针事实）：");
line("");
line("观察者  scope                  A层        B层        全局层     命中");
for (const r of rows) {
	line(`${r.观察者.padEnd(6)}  ${r.scope.padEnd(22)} ${r["A层"].padEnd(10)} ${r["B层"].padEnd(10)} ${r.全局层.padEnd(10)} ${r.命中}`);
}
line("");

// ── 分层计数（整库扫描，不用召回排序） ───────────────────────────────────
const all = await listFacts();
const buckets = new Map();
for (const f of all) {
	const tags = f.tags ?? [];
	const proj = tags.find((t) => typeof t === "string" && t.startsWith(PROJECT_TAG_PREFIX));
	const key = proj ?? "(全局层·无 tag)";
	buckets.set(key, (buckets.get(key) ?? 0) + 1);
}
line(`整库分层计数（共 ${all.length} 条事实）：`);
for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) line(`  ${k.padEnd(30)} ${v}`);
line("");

// ── 清理探针 ────────────────────────────────────────────────────────────
if (keep) {
	line(`--keep：保留探针事实 ${stamp}`);
} else {
	let done = 0;
	const targets = all.filter((f) => marked(f));
	for (const f of targets) {
		if (!f.id) continue;
		try {
			const res = await fetch(`${config.apiUrl}/v1/default/banks/${encodeURIComponent(bank)}/memories/${f.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ state: "invalidated" }),
			});
			if (res.ok) done += 1;
		} catch {
			/* 单条失败不影响整体清理 */
		}
	}
	line(`已作废 ${done}/${targets.length} 条探针事实`);
}
