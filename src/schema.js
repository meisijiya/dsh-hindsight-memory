/**
 * 配置 schema。
 *
 * 为什么单独一个文件：DSH 插件管理用它渲染配置表单，需要 schemastery 的 schema；
 * 但本包在开发态可能以 `file://` 方式被加载，那时从插件文件所在目录起算的
 * ESM 解析链拿不到 profile 的 node_modules（`@deepseek-ai/schemastery` 解析不到）。
 * 所以这里用**动态 import + 降级**：能拿到 schemastery 就给富 schema（表单带说明），
 * 拿不到就退回 StandardSchemaV1 —— 插件照常装载，只是表单退化为基础校验。
 *
 * 🔴 降级不是"失败即抛错"：记忆是增强，配置 schema 缺失不该让 profile 装载失败。
 */

import { normalizeConfig } from "./config.js";

/** @type {any} */
let z = null;
try {
	const mod = await import("@deepseek-ai/schemastery");
	z = mod?.default ?? mod?.z ?? (typeof mod?.object === "function" ? mod : null);
} catch {
	z = null;
}

/** 没有 schemastery 时的兜底：StandardSchemaV1。 */
const FALLBACK = {
	"~standard": {
		version: 1,
		vendor: "dsh-hindsight-memory",
		validate(value) {
			const raw = value && typeof value === "object" ? value : {};
			if (value !== undefined && value !== null && typeof value !== "object") {
				return { issues: [{ message: "配置必须是对象", path: [] }] };
			}
			return { value: normalizeConfig(raw) };
		},
	},
};

/**
 * 字段说明（两种 schema 共用同一份文案，避免两处漂移）。
 * 每一项都能对到 omp 的一个 `hindsight.*` 设置。
 */
export const FIELD_DOCS = {
	enabled: "总开关。false ⇒ 插件不注册任何工具、不发起任何网络请求。",
	inject: "是否注入常驻系统提示词段（记忆行为规约）。",
	writeEnabled: "是否允许写记忆（retain）。false ⇒ 只读挂载，灰度第一步用这个。",
	apiUrl: "Hindsight 服务根地址（本机 8888 = API，9999 = Control Plane 前端）。",
	bankId: "记忆库（bank）基名。必须与 omp 的 hindsight.bankId 一致，当前为 shared。",
	bankIdPrefix: "记忆库前缀（omp 的 hindsight.bankIdPrefix）。留空。",
	scoping: "作用域模式：global | per-project | per-project-tagged，与 omp 的 hindsight.scoping 一一对应。",
	types: "召回的事实类型。服务端只认 world / observation / experience；默认与 omp 的 recallTypes 同值。",
	budget: "召回预算：low | mid | high（omp 的 recallBudget）。",
	reflectBudget: "综合问答（reflect）的预算。omp 固定用 low。",
	maxTokens: "单次召回最大 token。omp 的 recallMaxTokens 默认 1024。",
	recallMaxQueryChars: "召回 query 截断长度。omp 的 recallMaxQueryChars 默认 800（保留尾部）。",
	autoRecall: "是否在会话首轮自动召回一次（结果落用户消息，不进系统提示词前缀）。",
	autoRetain: "是否在回合结束自动留存会话结论。",
	retainEveryNTurns: "自动留存的回合间隔（对齐 omp 的 retainEveryNTurns 默认 3；不限流会把项目层灌满对话噪声）。",
	sectionOrder: "注入段顺序（字面数字）。落在 FILE_REFERENCE(900) 与 TOOL_BASH(1000) 之间。",
	projectLabelOverride: "项目标签覆盖。留空 ⇒ 按 git 主 checkout 根目录 basename 小写推导（与 omp 同规则）。",
	transport: "传输层：rest | mcp。默认 mcp，走服务端官方 per-bank MCP 端点。",
	recallTimeoutMs: "召回超时（毫秒）。omp 的 recallTimeoutMs 默认 30000。",
	retainTimeoutMs: "写入超时（毫秒）。omp 的 retainTimeoutMs 默认 60000。",
	reflectTimeoutMs: "综合问答超时（毫秒）。omp 的 reflectTimeoutMs 默认 120000。",
	hygieneThreshold: "近重复阈值（0-1）。越高越保守。0.9 只抓逐字重复，0.8 能抓「同一件事换个说法」。",
	hygieneMaxFacts: "单次扫描条数上限。防 O(n²) 爆掉。",
	hygieneProjectMission: "项目层 observation 的保留口径（写入 bank 的 consolidation_strategies）。",
	hygieneProjectMaxObservations: "项目层 observation 条数上限。",
	hygieneGlobalMission: "全局层 observation 的保留口径（bank 级 observations_mission）。",
	hygieneGlobalMaxObservations: "全局层 observation 条数上限。",
	hygieneScope: "记忆卫生默认作用的层：all | project | global | other。",
	mentalModels: "是否维护 mental model（精神模型）层。omp 侧有，DSH 侧补齐才算行为对齐。",
	injectMentalModels: "是否把 mental model 正文注入会话（与 omp 的注入行为对齐）。",
	mentalModelPrefix: "mental model id 前缀。与 omp 的 id 空间分开，避免 409 与 tags 抢写。",
	mentalModelUserMaxTokens: "全局 mental model（user-preferences）的最大 token。",
	mentalModelProjectMaxTokens: "项目级 mental model（conventions / decisions）的最大 token。",
	operationsLimit: "运维观测：列 operation 时取多少条。",
	knowledgePages: "是否启用知识页（knowledge pages）层。服务端一等能力，与 omp 无关但两端共用同一个 bank。",
	pageSearchLimit: "知识页检索默认返回条数。",
	pageMaxTokens: "知识页正文合成上限（服务端硬下限 256）。",
	initiativeFolder: "initiative（正在做的事）页存放的文件夹名。",
};

/**
 * 插件配置 schema。
 * @type {any}
 */
export const Config = z
	? z.object({
			enabled: z.boolean().default(true).description(FIELD_DOCS.enabled),
			inject: z.boolean().default(true).description(FIELD_DOCS.inject),
			writeEnabled: z.boolean().default(true).description(FIELD_DOCS.writeEnabled),
			apiUrl: z.string().default("http://127.0.0.1:8888").description(FIELD_DOCS.apiUrl),
			bankId: z.string().default("shared").description(FIELD_DOCS.bankId),
			bankIdPrefix: z.string().default("").description(FIELD_DOCS.bankIdPrefix),
			scoping: z.string().default("per-project-tagged").description(FIELD_DOCS.scoping),
			types: z.array(z.string()).default(["world", "experience"]).description(FIELD_DOCS.types),
			budget: z.string().default("mid").description(FIELD_DOCS.budget),
			reflectBudget: z.string().default("low").description(FIELD_DOCS.reflectBudget),
			maxTokens: z.number().default(1024).description(FIELD_DOCS.maxTokens),
			recallMaxQueryChars: z.number().default(800).description(FIELD_DOCS.recallMaxQueryChars),
			autoRecall: z.boolean().default(false).description(FIELD_DOCS.autoRecall),
			autoRetain: z.boolean().default(false).description(FIELD_DOCS.autoRetain),
			retainEveryNTurns: z.number().default(3).description(FIELD_DOCS.retainEveryNTurns),
			sectionOrder: z.number().default(950).description(FIELD_DOCS.sectionOrder),
			projectLabelOverride: z.string().default("").description(FIELD_DOCS.projectLabelOverride),
			transport: z.string().default("mcp").description(FIELD_DOCS.transport),
			recallTimeoutMs: z.number().default(30_000).description(FIELD_DOCS.recallTimeoutMs),
			retainTimeoutMs: z.number().default(60_000).description(FIELD_DOCS.retainTimeoutMs),
			reflectTimeoutMs: z.number().default(120_000).description(FIELD_DOCS.reflectTimeoutMs),
			hygieneThreshold: z.number().default(0.9).description(FIELD_DOCS.hygieneThreshold),
			hygieneMaxFacts: z.number().default(500).description(FIELD_DOCS.hygieneMaxFacts),
			hygieneProjectMission: z
				.string()
				.default("只保留该项目中长期有效的技术决策、约定、硬约束与踩过的坑；不保留一次性进度、临时状态与重复表述。")
				.description(FIELD_DOCS.hygieneProjectMission),
			hygieneProjectMaxObservations: z.number().default(40).description(FIELD_DOCS.hygieneProjectMaxObservations),
			hygieneGlobalMission: z
				.string()
				.default("只保留跨项目长期有效的约定、环境事实与用户偏好；不保留一次性进度、临时状态与重复表述。")
				.description(FIELD_DOCS.hygieneGlobalMission),
			hygieneGlobalMaxObservations: z.number().default(30).description(FIELD_DOCS.hygieneGlobalMaxObservations),
			hygieneScope: z.string().default("all").description(FIELD_DOCS.hygieneScope),
			mentalModels: z.boolean().default(true).description(FIELD_DOCS.mentalModels),
			injectMentalModels: z.boolean().default(true).description(FIELD_DOCS.injectMentalModels),
			mentalModelPrefix: z.string().default("dsh").description(FIELD_DOCS.mentalModelPrefix),
			mentalModelUserMaxTokens: z.number().default(600).description(FIELD_DOCS.mentalModelUserMaxTokens),
			mentalModelProjectMaxTokens: z.number().default(800).description(FIELD_DOCS.mentalModelProjectMaxTokens),
			operationsLimit: z.number().default(20).description(FIELD_DOCS.operationsLimit),
			knowledgePages: z.boolean().default(true).description(FIELD_DOCS.knowledgePages),
			pageSearchLimit: z.number().default(5).description(FIELD_DOCS.pageSearchLimit),
			pageMaxTokens: z.number().default(2000).description(FIELD_DOCS.pageMaxTokens),
			initiativeFolder: z.string().default("Initiatives").description(FIELD_DOCS.initiativeFolder),
		})
	: FALLBACK;

/**
 * 可在线编辑的配置 schema（volatile 变体）。
 *
 * 为什么需要它：DSH 的「插件 → 配置」表单**只显示 volatile 字段**
 * （`dsh-settings` 的 `volatileForm()` 会把非 volatile 字段整段裁掉），
 * 并且只有**运行中**的插件行才会被投影成可编辑配置项（settings namespace）。
 * 没有 volatile 标记 ⇒ 宿主不生成表单 ⇒ 插件页显示「settings namespace 未就绪」。
 *
 * 做法与 dsh-mnemon 一致：把基础 schema 重新构造成 z schema，逐字段 `.volatile()`，
 * 再由 `loader/volatile-update` 事件把改动写回运行中的配置引用。
 */
export const LiveConfig = z
	? (() => {
			const live = new z(Config.toJSON());
			live.dict = Object.fromEntries(
				Object.entries(live.dict ?? {}).map(([key, field]) => [key, field.volatile()]),
			);
			return live;
		})()
	: Config;

export default Config;
