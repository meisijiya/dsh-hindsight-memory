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
	retainEveryNTurns: "自动留存的回合间隔（对齐 omp 的 retainEveryNTurns 默认 3）。",
	sectionOrder: "注入段顺序（字面数字）。落在 FILE_REFERENCE(900) 与 TOOL_BASH(1000) 之间。",
	projectLabelOverride: "项目标签覆盖。留空 ⇒ 按 git 主 checkout 根目录 basename 小写推导（与 omp 同规则）。",
	transport: "传输层：rest | mcp。默认 mcp，走服务端官方 per-bank MCP 端点。",
	recallTimeoutMs: "召回超时（毫秒）。omp 的 recallTimeoutMs 默认 30000。",
	retainTimeoutMs: "写入超时（毫秒）。omp 的 retainTimeoutMs 默认 60000。",
	reflectTimeoutMs: "综合问答超时（毫秒）。omp 的 reflectTimeoutMs 默认 120000。",
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
		})
	: FALLBACK;

export default Config;
