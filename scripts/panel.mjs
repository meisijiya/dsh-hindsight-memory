#!/usr/bin/env node
/**
 * dsh-hindsight-memory · 状态面板（终端版）
 *
 * 为什么有它：DSH 插件管理里能看到并改配置，但**记忆本身长什么样**（分层、条数、隔离）
 * 需要一个一眼能看的面板。这个脚本直接读 Hindsight 服务端原始数据，
 * 不经过模型 —— 与验收口径一致：模型自述不算证据，服务端数据才算。
 *
 * 用法：
 *   node scripts/panel.mjs                       # 默认 http://127.0.0.1:8888 / shared
 *   node scripts/panel.mjs --api http://host:8888 --bank shared --project 我的仓库
 *
 * 详细面板（官方前端，含知识页/实体/关系图）：http://127.0.0.1:9999
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
	const key = process.argv[i];
	if (!key.startsWith("--")) continue;
	const next = process.argv[i + 1];
	if (next && !next.startsWith("--")) {
		args.set(key.slice(2), next);
		i += 1;
	} else {
		args.set(key.slice(2), "true");
	}
}

const API = (args.get("api") ?? "http://127.0.0.1:8888").replace(/\/+$/, "");
const BANK = args.get("bank") ?? "shared";
/** 项目标签：显式 --project 优先，否则按 omp 同规则自动推导（git 主 checkout 根 basename 小写）。 */
async function detectProject() {
	const explicit = args.get("project");
	if (explicit) return explicit.toLowerCase();
	const { resolveProjectLabel } = await import("../src/label.js");
	return await resolveProjectLabel(args.get("dir") ?? process.cwd());
}
const PROJECT = await detectProject();
const PROJECT_TAG = PROJECT ? `project:${PROJECT}` : "";
const LIMIT = Number(args.get("limit") ?? 500);

const BOX = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", ml: "├", mr: "┤" };

function line(left, right, width) {
	const text = ` ${left}${" ".repeat(Math.max(1, width - visible(left) - 1))}${right} `;
	return `${BOX.v}${text}${BOX.v}`;
}

function visible(text) {
	// 中文按 2 列宽算
	let width = 0;
	for (const char of text) width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u.test(char) ? 2 : 1;
	return width;
}

function box(title, rows) {
	const width = Math.max(visible(title) + 4, ...rows.map((row) => visible(row) + 2), 40);
	const out = [];
	out.push(`${BOX.tl}${BOX.h.repeat(width + 2)}${BOX.tr}`);
	out.push(line(title, "", width));
	out.push(`${BOX.ml}${BOX.h.repeat(width + 2)}${BOX.mr}`);
	for (const row of rows) out.push(line(row, "", width));
	out.push(`${BOX.bl}${BOX.h.repeat(width + 2)}${BOX.br}`);
	return out.join("\n");
}

async function getJson(path) {
	const response = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${path}`);
	return response.json();
}

function factsOf(payload) {
	if (Array.isArray(payload)) return payload;
	if (Array.isArray(payload?.results)) return payload.results;
	if (Array.isArray(payload?.memories)) return payload.memories;
	if (Array.isArray(payload?.items)) return payload.items;
	return [];
}

async function main() {
	const health = await getJson("/health").catch((error) => ({ status: "unreachable", error: error.message }));
	const banks = await getJson("/v1/default/banks").catch(() => []);
	const bankList = Array.isArray(banks) ? banks : banks?.banks ?? [];
	const list = await getJson(`/v1/default/banks/${encodeURIComponent(BANK)}/memories/list?limit=${LIMIT}`).catch(() => []);
	const facts = factsOf(list);

	const globalFacts = facts.filter((fact) => !Array.isArray(fact.tags) || fact.tags.length === 0);
	const projectFacts = PROJECT_TAG
		? facts.filter((fact) => Array.isArray(fact.tags) && fact.tags.includes(PROJECT_TAG))
		: [];
	// 🔴 其它项目层 = 有标签但不是本项目标签的（无标签的已归全局层）。
	//    早前这里多了一个 `&& !PROJECT_TAG`，导致指定项目时「其它项目层」恒为 0（静默少算）。
	const foreignFacts = facts.filter(
		(fact) =>
			Array.isArray(fact.tags) &&
			fact.tags.length > 0 &&
			!(PROJECT_TAG && fact.tags.includes(PROJECT_TAG)),
	);

	console.log("");
	console.log(box("Hindsight 记忆面板（dsh-hindsight-memory）", [
		`服务 API        ${API}`,
		`Control Plane   ${API.replace(/:8888$/, ":9999")}  ← 官方前端（知识页 / 实体 / 关系图）`,
		`服务健康        ${health?.status ?? "unknown"}${health?.database ? ` / db ${health.database}` : ""}`,
		`记忆库(bank)    ${BANK}${bankList.length ? `（服务上共 ${bankList.length} 个：${bankList.map((b) => b.bank_id ?? b.id).join(", ")}）` : ""}`,
		`项目标签        ${PROJECT_TAG || "（未指定：所有带 project: 的事实都算别的项目）"}`,
	]));
	console.log("");
	console.log(box("分层统计（服务端原始数据）", [
		`全局层（无 tag）   ${globalFacts.length} 条   ← 所有项目都看得见`,
		`项目层（${PROJECT_TAG || "project:*"}）${projectFacts.length} 条   ← 只有本项目看得见`,
		`其它项目层          ${foreignFacts.length} 条   ← 本项目召回时会被过滤掉`,
		`合计               ${facts.length} 条`,
	]));

	// ── 记忆卫生：近重复 + observation scope（都在共享 bank 上，两端同时受益）
	const { findDuplicateGroups, planPrune } = await import("../src/hygiene.js");
	const active = facts.filter((fact) => (fact?.state ?? "valid") === "valid");
	const { groups } = findDuplicateGroups(active, { threshold: 0.8, maxFacts: LIMIT });
	const plan = planPrune(groups);
	const scopes = await getJson(
		`/v1/default/banks/${encodeURIComponent(BANK)}/observations/scopes`,
	).catch(() => null);
	const scopeText = Array.isArray(scopes?.scopes)
		? scopes.scopes
				.map((s) => `${(s.tags ?? []).join(",") || "(全局层)"} ${s.count} 条`)
				.join("   ")
		: "（读取失败）";
	console.log("");
	console.log(box("记忆卫生（共享 bank 层 · 两端同时受益）", [
		`近重复组（阈值0.8）  ${groups.length} 个 → 待作废 ${plan.invalidate.length} 条`,
		`observation scope   ${scopeText}`,
		`服务端自动整理      consolidation_strategies（项目层）+ max_observations_per_scope（全局层）`,
		`手动整理            node scripts/hygiene.mjs --threshold 0.8 --apply   ← 可逆：state 改回 valid 即恢复`,
	]));
	console.log("");
	console.log(box("最近 8 条事实", facts.slice(0, 8).map((fact) => {
		const tags = Array.isArray(fact.tags) && fact.tags.length ? fact.tags.join(",") : "(无标签=全局层)";
		const text = String(fact.text ?? fact.content ?? "").replace(/\s+/gu, " ").slice(0, 64);
		return `[${tags}] ${text}`;
	})));
	console.log("");
}

main().catch((error) => {
	console.error(`面板读取失败：${error.message}`);
	process.exitCode = 1;
});
