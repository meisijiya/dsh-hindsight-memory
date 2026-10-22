/**
 * 记忆看板的 RPC 端点实现（v0.7.0）。
 *
 * 🔴 为什么在服务端做取数，而不是让浏览器直连 Hindsight：
 *    Hindsight 没有 CORS 中间件（OPTIONS 预检直接 405），
 *    浏览器直连一定失败。宿主 `connection` 服务的 RPC 通道自带
 *    Host/Origin 栅栏与会话 cookie 鉴权，浏览器同源 fetch 就能用。
 *
 * 端点全部**只读**：看板是"看"的路径，任何写操作都必须走记忆工具
 * （带 confirm + reason 护栏），否则页面就成了绕过护栏的后门。
 */

import { HindsightMemoryClient } from "./client.js";
import { computeBankScope } from "./parity.js";
import { flattenTree } from "./pages.js";
import { describeLayers } from "./hygiene.js";
import { auditPlan } from "./maintenance.js";
import {
	PANEL_ENDPOINTS,
	buildModelSummary,
	buildOperationSummary,
	buildPageSummary,
	buildPanelSnapshot,
	normalizeFactList,
	normalizeModelList,
	normalizeOperationList,
	pickPublicConfig,
} from "./panel.js";

/** 一次拉取的事实条数上限（与服务端 /memories/list 的分页上限对齐）。 */
const FACT_LIMIT = 500;
/** 一次拉取的 operation 条数上限。 */
const OPERATION_LIMIT = 100;
/** 一次拉取的 mental model 条数上限。 */
const MODEL_LIMIT = 50;

/**
 * 构造看板的 RPC 处理器。
 *
 * @param {object} options
 * @param {object} options.config 归一化后的配置（**引用**，会被热更新原地改写）。
 * @param {(msg: string) => void} [options.log]
 * @param {() => string} [options.resolveLabel] 当前项目标签（无会话时回落）。
 * @returns {(endpoint: string, payload: unknown) => Promise<object>}
 */
export function createPanelRpcHandler({ config, log = () => {}, resolveLabel = () => "" }) {
	// 面板读整库；标签只影响 recall/retain，不影响 /memories/list。
	const client = new HindsightMemoryClient({ config, label: "", log });

	const fail = (code, message) => ({
		ok: false,
		error: { code, message, details: {} },
	});

	return async (endpoint, payload) => {
		if (!PANEL_ENDPOINTS.includes(endpoint)) {
			return fail("hindsight/unknown-endpoint", `未知端点：${endpoint}`);
		}
		const label =
			typeof payload?.projectLabel === "string" && payload.projectLabel
				? payload.projectLabel
				: resolveLabel() || config.projectLabelOverride || "";
		try {
			// 配置可能被热更新 ⇒ 每次请求都重算 bank scope。
			client.scope = computeBankScope(config, label);

			if (endpoint === "config") {
				return { ok: true, value: pickPublicConfig(config) };
			}

			if (endpoint === "layers") {
				const facts = normalizeFactList(await client.listFacts({ limit: FACT_LIMIT }));
				return { ok: true, value: { projectLabel: label, layers: describeLayers(facts, label) } };
			}

			if (endpoint === "operations") {
				const operations = normalizeOperationList(
					await client.listOperations({ limit: OPERATION_LIMIT }),
				);
				return { ok: true, value: buildOperationSummary(operations) };
			}

			if (endpoint === "models") {
				const models = normalizeModelList(await client.listMentalModels({ limit: MODEL_LIMIT }));
				return { ok: true, value: buildModelSummary(models) };
			}

			if (endpoint === "pages") {
				const tree = await client.listKnowledgeTree();
				return { ok: true, value: buildPageSummary(flattenTree(tree).pages) };
			}

			if (endpoint === "audit") {
				const [facts, operations, tree] = await Promise.all([
					client.listFacts({ limit: FACT_LIMIT }),
					client.listOperations({ limit: OPERATION_LIMIT }),
					client.listKnowledgeTree(),
				]);
				const plan = auditPlan({
					facts: normalizeFactList(facts),
					pages: flattenTree(tree).pages,
					operations: normalizeOperationList(operations),
					now: Date.now(),
					staleDays: config.maintenanceStaleDays,
					stuckMinutes: config.maintenanceStuckMinutes,
					threshold: config.hygieneThreshold,
				});
				return { ok: true, value: plan };
			}

			// overview：一次给全，浏览器只渲染，不再回服务端取第二次。
			const [facts, operations, models, tree, bank] = await Promise.all([
				client.listFacts({ limit: FACT_LIMIT }),
				client.listOperations({ limit: OPERATION_LIMIT }),
				client.listMentalModels({ limit: MODEL_LIMIT }),
				client.listKnowledgeTree(),
				client.bankOverview(),
			]);
			return {
				ok: true,
				value: buildPanelSnapshot({
					facts: normalizeFactList(facts),
					operations: normalizeOperationList(operations),
					models: normalizeModelList(models),
					pages: flattenTree(tree).pages,
					bank,
					projectLabel: label,
					config: pickPublicConfig(config),
				}),
			};
		} catch (error) {
			return fail("hindsight/panel-failed", error?.message ?? String(error));
		}
	};
}
