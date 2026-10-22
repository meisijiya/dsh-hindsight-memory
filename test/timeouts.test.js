import assert from "node:assert/strict";
import test from "node:test";

import { HindsightMemoryClient } from "../src/client.js";
import { DEFAULTS, normalizeConfig } from "../src/config.js";

// Server-side LLM budget in this container: HINDSIGHT_API_LLM_TIMEOUT=600,
// HINDSIGHT_API_MENTAL_MODEL_REFRESH_LLM_TIMEOUT=600,
// HINDSIGHT_API_REFLECT_WALL_TIMEOUT=1800.
const SERVER_LLM_BUDGET_MS = 600_000;

test("maintenance timeout default is longer than the server LLM budget", () => {
	assert.ok(
		DEFAULTS.maintenanceTimeoutMs > SERVER_LLM_BUDGET_MS,
		"client deadline must outlast the server budget, otherwise the client always times out first",
	);
	assert.equal(normalizeConfig({}).maintenanceTimeoutMs, DEFAULTS.maintenanceTimeoutMs);
});

test("maintenance timeout is clamped into a sane range", () => {
	assert.equal(normalizeConfig({ maintenanceTimeoutMs: 1_800_000 }).maintenanceTimeoutMs, 1_800_000);
	assert.equal(normalizeConfig({ maintenanceTimeoutMs: 10 }).maintenanceTimeoutMs, DEFAULTS.maintenanceTimeoutMs);
	assert.equal(normalizeConfig({ maintenanceTimeoutMs: "x" }).maintenanceTimeoutMs, DEFAULTS.maintenanceTimeoutMs);
	assert.equal(normalizeConfig({ maintenanceTimeoutMs: 9_000_000 }).maintenanceTimeoutMs, 1_800_000);
});

test("long-running endpoints use the maintenance timeout instead of the short ones", async () => {
	const config = normalizeConfig({ transport: "rest" });
	const client = new HindsightMemoryClient({ config, label: "demo" });
	const seen = [];
	client.postJson = async (path, body, opts) => {
		seen.push({ path, timeoutMs: opts?.timeoutMs });
		return {};
	};
	client.patchJson = async (path, body, opts) => {
		seen.push({ path, timeoutMs: opts?.timeoutMs });
		return {};
	};
	client.deleteJson = async (path, opts) => {
		seen.push({ path, timeoutMs: opts?.timeoutMs });
		return {};
	};
	await client.dryRunRefreshMentalModel("m1");
	await client.refreshMentalModel("m1");
	await client.dryRunExtract("hello");
	await client.clearMentalModel("m1");
	await client.deleteMentalModel("m1");
	await client.updateKnowledgeNode("k1", { name: "x" });
	await client.deleteKnowledgeNode("k1");
	assert.equal(seen.length, 7);
	for (const call of seen) {
		assert.equal(
			call.timeoutMs,
			DEFAULTS.maintenanceTimeoutMs,
			`${call.path} must use maintenanceTimeoutMs`,
		);
	}
});
