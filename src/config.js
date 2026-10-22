/**
 * 运行时配置。
 *
 * 🔴 为什么自己解析而不引 schemastery：
 *    本插件以 `file://` 方式被 DSH 加载时，Node 的 ESM 解析链从**插件文件所在目录**起算，
 *    拿不到 profile 的 node_modules（@deepseek-ai/schemastery 就解析不到）。
 *    所以本包**零运行时依赖**——只用 Node 内置模块。
 */

/** 默认值。每一项都对应 omp 侧的一个 `hindsight.*` 设置。 */
export const DEFAULTS = {
	/** 总开关。false ⇒ 完全不注册、不联网。 */
	enabled: true,
	/** 是否注入常驻系统提示词段。 */
	inject: true,
	/** 是否允许写。false ⇒ 只读（灰度第一步用这个）。 */
	writeEnabled: true,
	/** Hindsight 服务根地址。 */
	apiUrl: "http://127.0.0.1:8888",
	/** bank 基名。必须与 omp 的 hindsight.bankId 一致。 */
	bankId: "shared",
	/** bank 前缀（omp 的 hindsight.bankIdPrefix）。 */
	bankIdPrefix: "",
	/** 作用域模式，与 omp 的 hindsight.scoping 一一对应。 */
	scoping: "per-project-tagged",
	/** 召回的 fact 类型。服务端只认 world / observation / experience。
	 *  默认与 omp 一致：["world","experience"]（omp 的 recallTypes 默认值）。 */
	types: ["world", "experience"],
	/** 召回预算：low | mid | high。 */
	budget: "mid",
	/** reflect（综合问答）的预算。omp 的 reflect 固定用 low。 */
	reflectBudget: "low",
	/** 召回 query 截断长度。omp 的 recallMaxQueryChars 默认 800（保留尾部）。 */
	recallMaxQueryChars: 800,
	/** 单次召回最大 token。omp 的 recallMaxTokens 默认 1024。 */
	maxTokens: 1024,
	/** 自动召回（首轮一次）。omp 的 hindsight.autoRecall 默认 true ⇒ 保持一致。 */
	autoRecall: true,
	/** 自动留存（回合结束）。omp 的 hindsight.autoRetain 默认 true ⇒ 保持一致。
	 *  注意：本插件的自动留存是「本回合文本」简化版（omp 是整段 session 重发），
	 *  想完全关掉自动写入：在插件配置里把 writeEnabled 或 autoRetain 置 false 即可。 */
	autoRetain: true,
	/** 自动留存的回合间隔。 */
	retainEveryNTurns: 3,
	/** 注入段顺序（字面数字）。 */
	sectionOrder: 950,
	/** 项目标签覆盖（留空 ⇒ 按 git 主 checkout 根目录 basename 小写推导）。 */
	projectLabelOverride: "",
	/** 超时（毫秒）。与 omp 默认一致。 */
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 60_000,
	reflectTimeoutMs: 120_000,
	/** 传输层：rest | mcp。默认 mcp（服务端官方 per-bank MCP 端点）。 */
	transport: "mcp",
};

const BUDGETS = new Set(["low", "mid", "high"]);
const SCOPINGS = new Set(["global", "per-project", "per-project-tagged"]);
const FACT_TYPES = new Set(["world", "experience", "observation"]);

function bool(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}

function int(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

function str(value, fallback) {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * StandardSchemaV1 校验器。
 *
 * 为什么自己实现：插件必须能被任何安装形态加载（包括 file:// 直接加载），
 * 那时 Node 的 ESM 解析链从插件目录起算，拿不到 profile 的
 * @deepseek-ai/schemastery ⇒ 不能 import 它。
 *
 * DSH 的插件层只要看到 `~standard` 就会用这个校验器，
 * 于是配置错误在装载期就暴露，而不是等到第一次调用才炸。
 */
export const Config = {
	"~standard": {
		version: 1,
		vendor: "dsh-hindsight-memory",
		validate(value) {
			const raw = value && typeof value === "object" ? value : {};
			const issues = [];
			if (value !== undefined && value !== null && typeof value !== "object") {
				issues.push({ message: "配置必须是对象", path: [] });
			}
			if (issues.length > 0) return { issues };
			return { value: normalizeConfig(raw) };
		},
	},
};

/**
 * 归一化配置：任何非法输入都回落到默认值，**绝不抛错**。
 *
 * 理由：插件装载失败 = 整个 profile 起不来（用户看到的现象是"DSH 打不开"），
 * 而记忆只是一个可选增强。配置写错应该"降级"而不是"炸掉"。
 */
export function normalizeConfig(raw = {}) {
	const scoping = SCOPINGS.has(raw.scoping) ? raw.scoping : DEFAULTS.scoping;
	const budget = BUDGETS.has(raw.budget) ? raw.budget : DEFAULTS.budget;
	const types = Array.isArray(raw.types)
		? raw.types.filter((t) => FACT_TYPES.has(t))
		: DEFAULTS.types;
	return {
		enabled: bool(raw.enabled, DEFAULTS.enabled),
		inject: bool(raw.inject, DEFAULTS.inject),
		writeEnabled: bool(raw.writeEnabled, DEFAULTS.writeEnabled),
		apiUrl: str(raw.apiUrl, DEFAULTS.apiUrl).replace(/\/+$/, ""),
		bankId: str(raw.bankId, DEFAULTS.bankId),
		bankIdPrefix: str(raw.bankIdPrefix, DEFAULTS.bankIdPrefix),
		scoping,
		budget,
		reflectBudget: BUDGETS.has(raw.reflectBudget) ? raw.reflectBudget : DEFAULTS.reflectBudget,
		recallMaxQueryChars: int(raw.recallMaxQueryChars, DEFAULTS.recallMaxQueryChars, 64, 8_000),
		maxTokens: int(raw.maxTokens, DEFAULTS.maxTokens, 64, 32_000),
		types: types.length > 0 ? types : DEFAULTS.types,
		autoRecall: bool(raw.autoRecall, DEFAULTS.autoRecall),
		autoRetain: bool(raw.autoRetain, DEFAULTS.autoRetain),
		retainEveryNTurns: int(raw.retainEveryNTurns, DEFAULTS.retainEveryNTurns, 1, 100),
		sectionOrder: int(raw.sectionOrder, DEFAULTS.sectionOrder, 0, 10_000),
		projectLabelOverride: str(raw.projectLabelOverride, DEFAULTS.projectLabelOverride),
		recallTimeoutMs: int(raw.recallTimeoutMs, DEFAULTS.recallTimeoutMs, 1_000, 600_000),
		retainTimeoutMs: int(raw.retainTimeoutMs, DEFAULTS.retainTimeoutMs, 1_000, 600_000),
		reflectTimeoutMs: int(raw.reflectTimeoutMs, DEFAULTS.reflectTimeoutMs, 1_000, 600_000),
		transport: raw.transport === "rest" ? "rest" : "mcp",
	};
}
