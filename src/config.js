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
	/** bank 基名。必须与 omp 的 hindsight.bankId 一致（本机为 mem）。
	 *  🔴 这是**兜底默认值**：实测 DSH 运行时没有把行配置投递给本插件，
	 *  插件拿到的 raw config 为空 ⇒ 真正生效的是这里的默认值。
	 *  改这里必须同时改 cordis.patch.yml 与 src/schema.js（见 test/defaults.test.js 的一致性门禁）。 */
	bankId: "mem",
	/** bank 前缀（omp 的 hindsight.bankIdPrefix）。 */
	bankIdPrefix: "",
	/** 作用域模式，与 omp 的 hindsight.scoping 一一对应（本机为 per-project：每项目一个 bank）。 */
	scoping: "per-project",
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
	/** 自动留存的回合间隔。omp 的 hindsight.retainEveryNTurns 默认 3 ⇒ 保持一致，
	 *  避免项目层被每轮对话噪声灌满（实测未限流时项目层 137 条 vs 全局层 23 条）。 */
	retainEveryNTurns: 3,
	/** 注入段顺序（字面数字）。 */
	sectionOrder: 950,
	/** 项目标签覆盖（留空 ⇒ 按 git 主 checkout 根目录 basename 小写推导）。 */
	projectLabelOverride: "",
	/** 超时（毫秒）。与 omp 默认一致。 */
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 60_000,
	reflectTimeoutMs: 120_000,
	/**
	 * 维护类长操作的超时（毫秒）。
	 *
	 * 🔴 为什么单独一个键：服务端的 LLM 预算是 600s、reflect 墙钟是 1800s
	 *   （容器 env：HINDSIGHT_API_LLM_TIMEOUT / HINDSIGHT_API_MENTAL_MODEL_REFRESH_LLM_TIMEOUT
	 *    = 600，HINDSIGHT_API_REFLECT_WALL_TIMEOUT = 1800）。
	 *   客户端 deadline 必须比服务端预算更长，否则永远是我们先超时、
	 *   服务端还在算 —— 表现为 dry-run-refresh / refresh 报「120000ms 超时」。
	 *   900s 是留足余量又不至于让会话无限挂住的值。
	 */
	maintenanceTimeoutMs: 900_000,
	/** 传输层：rest | mcp。默认 mcp（服务端官方 per-bank MCP 端点）。 */
	transport: "mcp",
	/** 记忆卫生：近重复判定阈值（0-1）。越高越保守。 */
	hygieneThreshold: 0.9,
	/** 单次扫描的事实条数上限（防 O(n²) 爆掉）。 */
	hygieneMaxFacts: 500,
	/** 项目层 observation 口径（写进 bank 的 consolidation_strategies）。 */
	hygieneProjectMission:
		"只保留该项目中长期有效的技术决策、约定、硬约束与踩过的坑；不保留一次性进度、临时状态与重复表述。",
	/** 项目层每个 scope 的 observation 条数上限。 */
	hygieneProjectMaxObservations: 40,
	/** 全局层 observation 口径（无标签 scope 只能靠 bank 级默认值兜住）。 */
	hygieneGlobalMission:
		"只保留跨项目长期有效的约定、环境事实与用户偏好；不保留一次性进度、临时状态与重复表述。",
	/** 全局层 observation 条数上限。 */
	hygieneGlobalMaxObservations: 30,
	/** 记忆卫生默认作用的层：all | project | global | other。 */
	hygieneScope: "all",
	/** 是否维护 mental model（精神模型）层。omp 侧有，DSH 侧补齐才算行为对齐。 */
	mentalModels: true,
	/** 是否把 mental model 正文注入会话（与 omp 的注入行为对齐）。 */
	injectMentalModels: true,
	/**
	 * mental model id 前缀。**默认空** = 与 omp 用完全相同的 id（两端共用同一份模型）。
	 * 填值（如 `dsh`）会在 omp 的 id 前再加一层，用于「同一 bank 内两端必须用不同模型」
	 * 的特殊场景。日常不需要填。
	 */
	mentalModelPrefix: "",
	/** 全局 mental model（user-preferences）的最大 token。 */
	mentalModelUserMaxTokens: 600,
	/** 项目级 mental model（conventions / decisions）的最大 token。 */
	mentalModelProjectMaxTokens: 800,
	/** 运维观测：列 operation 时取多少条。 */
	operationsLimit: 20,
	/** 是否启用知识页（knowledge pages）层。服务端一等能力，纯客户端封装。 */
	knowledgePages: true,
	/** 知识页检索默认返回条数。 */
	pageSearchLimit: 5,
	/** 知识页正文合成上限（服务端硬下限 256）。 */
	pageMaxTokens: 2000,
	/** initiative 页存放的文件夹名。 */
	initiativeFolder: "Initiatives",
	/** 陈旧判定阈值（天）：updated_at 距今超过这个天数就算陈旧候选。 */
	maintenanceStaleDays: 180,
	/** 卡住判定阈值（分钟）：pending/processing 超过这个分钟数算卡住。 */
	maintenanceStuckMinutes: 30,
	/** 破坏性动作是否必须显式 confirm=true（保守默认：开）。 */
	maintenanceRequireConfirm: true,
};

const BUDGETS = new Set(["low", "mid", "high"]);
const SCOPINGS = new Set(["global", "per-project", "per-project-tagged"]);
const FACT_TYPES = new Set(["world", "experience", "observation"]);
/** 记忆卫生可作用的层。 */
const HYGIENE_SCOPES = new Set(["all", "project", "global", "other"]);

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
 * 超时专用解析：**比下限还小就回落默认值**，而不是夹到下限。
 *
 * 🔴 为什么不用 int() 的夹取语义：把 10ms 夹成 1000ms 仍然是个必然超时的值，
 *   而“已知可用的默认值”才是真正的安全兜底。超大值才夹到上限。
 */
function timeout(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	if (n < min) return fallback;
	return Math.min(max, Math.trunc(n));
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
		reflectTimeoutMs: int(raw.reflectTimeoutMs, DEFAULTS.reflectTimeoutMs, 1_000, 1_800_000),
		maintenanceTimeoutMs: timeout(
			raw.maintenanceTimeoutMs,
			DEFAULTS.maintenanceTimeoutMs,
			60_000,
			1_800_000,
		),
		transport: raw.transport === "rest" ? "rest" : "mcp",
		hygieneThreshold: Math.min(
			1,
			Math.max(0.5, Number(raw.hygieneThreshold) || DEFAULTS.hygieneThreshold),
		),
		hygieneMaxFacts: int(raw.hygieneMaxFacts, DEFAULTS.hygieneMaxFacts, 20, 2_000),
		hygieneProjectMission: str(raw.hygieneProjectMission, DEFAULTS.hygieneProjectMission),
		hygieneProjectMaxObservations: int(
			raw.hygieneProjectMaxObservations,
			DEFAULTS.hygieneProjectMaxObservations,
			1,
			500,
		),
		hygieneGlobalMission: str(raw.hygieneGlobalMission, DEFAULTS.hygieneGlobalMission),
		hygieneGlobalMaxObservations: int(
			raw.hygieneGlobalMaxObservations,
			DEFAULTS.hygieneGlobalMaxObservations,
			1,
			500,
		),
		hygieneScope: HYGIENE_SCOPES.has(raw.hygieneScope) ? raw.hygieneScope : DEFAULTS.hygieneScope,
		mentalModels: bool(raw.mentalModels, DEFAULTS.mentalModels),
		injectMentalModels: bool(raw.injectMentalModels, DEFAULTS.injectMentalModels),
		mentalModelPrefix: str(raw.mentalModelPrefix, DEFAULTS.mentalModelPrefix),
		mentalModelUserMaxTokens: int(
			raw.mentalModelUserMaxTokens,
			DEFAULTS.mentalModelUserMaxTokens,
			// 服务端硬性要求 max_tokens >= 256，否则 422 greater_than_equal。
			256,
			8_000,
		),
		mentalModelProjectMaxTokens: int(
			raw.mentalModelProjectMaxTokens,
			DEFAULTS.mentalModelProjectMaxTokens,
			256,
			8_000,
		),
		operationsLimit: int(raw.operationsLimit, DEFAULTS.operationsLimit, 1, 200),
		knowledgePages: bool(raw.knowledgePages, DEFAULTS.knowledgePages),
		pageSearchLimit: int(raw.pageSearchLimit, DEFAULTS.pageSearchLimit, 1, 50),
		// 服务端硬性要求 max_tokens >= 256，否则 422 greater_than_equal。
		pageMaxTokens: int(raw.pageMaxTokens, DEFAULTS.pageMaxTokens, 256, 8_000),
		initiativeFolder: str(raw.initiativeFolder, DEFAULTS.initiativeFolder),
		maintenanceStaleDays: int(raw.maintenanceStaleDays, DEFAULTS.maintenanceStaleDays, 1, 3650),
		maintenanceStuckMinutes: int(raw.maintenanceStuckMinutes, DEFAULTS.maintenanceStuckMinutes, 1, 1440),
		maintenanceRequireConfirm: bool(raw.maintenanceRequireConfirm, DEFAULTS.maintenanceRequireConfirm),
	};
}
