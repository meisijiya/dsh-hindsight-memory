#!/usr/bin/env node
/**
 * 记忆卫生 CLI —— 在**共享 bank** 上做去重/整理。
 *
 * 为什么是独立脚本而不是只靠插件工具：
 *   整理要能被**定时**跑（cron / 任务计划），而不是等人手动调工具；
 *   而它作用在 DSH 与 omp 共享的同一个 bank 上 ⇒ 跑一次，两端同时受益。
 *
 * 用法：
 *   node scripts/hygiene.mjs                     # 只读预览
 *   node scripts/hygiene.mjs --apply             # 作废近重复事实（可逆）
 *   node scripts/hygiene.mjs --consolidate       # 触发服务端合并 observation
 *   node scripts/hygiene.mjs --bank shared --api http://127.0.0.1:8888 --threshold 0.9
 */

import { findDuplicateGroups, planPrune, summarizeGroups } from "../src/hygiene.js";

function parseArgs(argv) {
	const args = {
		api: "http://127.0.0.1:8888",
		bank: "shared",
		threshold: 0.9,
		limit: 500,
		apply: false,
		consolidate: false,
		includeObservations: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--apply") args.apply = true;
		else if (arg === "--consolidate") args.consolidate = true;
		else if (arg === "--include-observations") args.includeObservations = true;
		else if (arg === "--api") args.api = argv[++i];
		else if (arg === "--bank") args.bank = argv[++i];
		else if (arg === "--threshold") args.threshold = Number(argv[++i]);
		else if (arg === "--limit") args.limit = Number(argv[++i]);
		else if (arg === "--help" || arg === "-h") {
			console.log(
				"用法: node scripts/hygiene.mjs [--api URL] [--bank ID] [--threshold 0-1] [--limit N] [--apply] [--consolidate] [--include-observations]",
			);
			process.exit(0);
		}
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
const base = `${String(args.api).replace(/\/+$/, "")}/v1/default/banks/${encodeURIComponent(args.bank)}`;
const enc = (value) => encodeURIComponent(String(value));

async function json(url, init) {
	const response = await fetch(url, init);
	const text = await response.text();
	if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text };
	}
}

const list = await json(`${base}/memories/list?limit=${enc(args.limit)}`, { method: "GET" });
const items = Array.isArray(list) ? list : (list?.items ?? list?.memories ?? []);
const active = items.filter((item) => (item?.state ?? "valid") === "valid");
const { groups, crossScope } = findDuplicateGroups(active, {
	threshold: args.threshold,
	maxFacts: args.limit,
	includeObservations: args.includeObservations,
});
const plan = planPrune(groups);

console.log(`bank=${args.bank} 扫描 ${active.length} 条有效事实（阈值 ${args.threshold}）`);
console.log(`重复组 ${groups.length} 个，待作废 ${plan.invalidate.length} 条，跨层同文 ${crossScope.length} 条`);
for (const group of summarizeGroups(groups, { limit: 10 })) {
	console.log(`  · [${group.scope}] ×${group.count}`);
	for (const sample of group.samples) {
		console.log(`      ${sample.id} ${sample.text}`);
	}
}

if (args.apply && plan.invalidate.length > 0) {
	let ok = 0;
	let failed = 0;
	for (const fact of plan.invalidate) {
		try {
			await json(`${base}/memories/${enc(fact.id)}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ state: "invalidated" }),
			});
			ok += 1;
		} catch (error) {
			failed += 1;
			console.error(`  ! ${fact.id} ${error.message}`);
		}
	}
	console.log(`已作废 ${ok} 条，失败 ${failed} 条（服务端可逆：state 改回 valid 即可恢复）`);
} else if (plan.invalidate.length > 0) {
	console.log("（预览模式；加 --apply 才会真正作废）");
}

if (args.consolidate) {
	const result = await json(`${base}/consolidate`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	console.log("consolidate:", JSON.stringify(result).slice(0, 300));
}
