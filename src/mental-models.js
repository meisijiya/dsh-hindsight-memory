/**
 * Mental model（精神模型）层 —— 与 omp 对齐的第三层记忆。
 *
 * 背景（来自 omp 侧实测报告 `omp-hindsight-report.md`）：
 *   Hindsight 除了「事实层」（world / observation / experience）之外，还有一层
 *   **mental model**：由服务端用 LLM 从事实层归纳出来的、可注入系统提示的长期画像。
 *   omp 每次启动都会保证 3 个 mental model 存在，并把正文注入会话提示：
 *     ① `user-preferences`（全局层，**无 tag**）
 *     ② `project-conventions-<slug>`（项目层，tags=[project:<name>]）
 *     ③ `project-decisions-<slug>`（项目层，tags=[project:<name>]）
 *
 * 🔴 三个必须踩准的坑（都是报告里实测过的）：
 *   1. `POST /mental-models` 是**仅创建**，不是 upsert：重复 id 返回 409，
 *      且**已有模型的 tags 不会被改写** ⇒ 想改标签必须 `PATCH`。
 *   2. mental model id 必须**全局唯一**。omp 的 slug 规则是「只保留 ASCII 字母数字」，
 *      于是所有纯中文项目名都退化成 `project-conventions-project` ⇒ 互相抢同一个 id。
 *      本插件改用「**完整项目名 + 固定前缀**」：中文名不再退化，也和 omp 的 id 互不冲突。
 *   3. 触发器必须 `{mode:"delta", refresh_after_consolidation:true}`，
 *      否则 consolidation 之后不会自动增量刷新 ⇒ 模型内容会一直停在旧快照。
 */

/** 全局 mental model 的固定 id 片段。 */
export const USER_MODEL = "user-preferences";
/** 项目约定 mental model 的固定 id 片段。 */
export const CONVENTIONS_MODEL = "project-conventions";
/** 项目决策 mental model 的固定 id 片段。 */
export const DECISIONS_MODEL = "project-decisions";

/**
 * 三个 mental model 的 source_query（固定英文原文，与语言无关，与 omp 同措辞）。
 * 它们是**给服务端 LLM 的检索指令**，不是展示文案。
 */
export const SOURCE_QUERIES = Object.freeze({
	user:
		"What does the user prefer in coding style, tooling, communication, and review? Capture only durable preferences expressed across sessions, not one-off requests.",
	conventions:
		"What are this project's conventions for code style, build, testing, release, and pull-request review? Only include conventions that are explicit in the project (settings, scripts, contributor docs, repeatedly enforced in review).",
	decisions:
		"What durable architectural or product decisions have been made for this project, and what rationale or trade-offs were recorded? Include only decisions that are stable across sessions; exclude transient plans, unresolved ideas, and active task state.",
});

/**
 * 归一化前缀：只允许小写字母、数字、连字符。
 * @param {string} value 原始前缀。
 * @returns {string}
 */
function normalizePrefix(value) {
	const cleaned = String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "dsh";
}

/**
 * 生成 3 个 mental model 的 id。
 *
 * 关键：项目名用**完整标签**（不裁 ASCII），所以中文项目名不会互相碰撞；
 * 再加固定前缀，和 omp 的 id 空间彻底分开（避免 409 与 tags 抢写）。
 *
 * @param {{mentalModelPrefix?: string}} config 归一化配置。
 * @param {string} label 项目标签（小写 basename）。
 * @returns {{user: string, conventions: string, decisions: string}}
 */
export function mentalModelIds(config, label) {
	const prefix = normalizePrefix(config?.mentalModelPrefix);
	const project = String(label ?? "").trim() || "unknown";
	return {
		user: `${prefix}-${USER_MODEL}`,
		conventions: `${prefix}-${CONVENTIONS_MODEL}-${project}`,
		decisions: `${prefix}-${DECISIONS_MODEL}-${project}`,
	};
}

/**
 * 生成 3 个 mental model 的创建规格。
 *
 * @param {{mentalModelPrefix?: string, mentalModelUserMaxTokens?: number, mentalModelProjectMaxTokens?: number}} config
 * @param {string} label 项目标签。
 * @param {string[]} projectTags 项目层标签（通常是 [`project:<label>`]）。
 * @returns {Array<{id: string, name: string, source_query: string, tags?: string[], max_tokens: number, trigger: object}>}
 */
export function mentalModelSpecs(config, label, projectTags = []) {
	const ids = mentalModelIds(config, label);
	const userMax = Number(config?.mentalModelUserMaxTokens) || 600;
	const projectMax = Number(config?.mentalModelProjectMaxTokens) || 800;
	const trigger = { mode: "delta", refresh_after_consolidation: true };
	const tags = projectTags.length > 0 ? [...projectTags] : undefined;
	return [
		{
			id: ids.user,
			name: "User Preferences",
			source_query: SOURCE_QUERIES.user,
			max_tokens: userMax,
			trigger,
		},
		{
			id: ids.conventions,
			name: "Project Conventions",
			source_query: SOURCE_QUERIES.conventions,
			tags,
			max_tokens: projectMax,
			trigger,
		},
		{
			id: ids.decisions,
			name: "Project Decisions",
			source_query: SOURCE_QUERIES.decisions,
			tags,
			max_tokens: projectMax,
			trigger,
		},
	];
}

/**
 * 依据服务端现状，算出「确保这 3 个存在」的动作计划。
 *
 * 规则（对应坑 1）：
 *   - 不存在 ⇒ create（POST）；
 *   - 存在但标签不符 ⇒ patch tags（POST 不会改写 tags，只能 PATCH）；
 *   - 存在且标签一致 ⇒ keep（不打扰，避免每次启动都写）。
 *
 * @param {Array<{id?: string, tags?: string[]}>} existing 服务端现有 mental model（元数据）。
 * @param {Array<{id: string, tags?: string[]}>} specs 目标规格。
 * @returns {{create: Array, patch: Array, keep: Array}}
 */
export function planEnsure(existing, specs) {
	const byId = new Map();
	for (const model of existing ?? []) {
		const id = typeof model?.id === "string" ? model.id : model?.mental_model_id;
		if (id) byId.set(id, model);
	}
	const create = [];
	const patch = [];
	const keep = [];
	for (const spec of specs ?? []) {
		const current = byId.get(spec.id);
		if (!current) {
			create.push(spec);
			continue;
		}
		const currentTags = Array.isArray(current.tags) ? current.tags : [];
		const wantedTags = Array.isArray(spec.tags) ? spec.tags : [];
		const same =
			currentTags.length === wantedTags.length &&
			currentTags.every((tag) => wantedTags.includes(tag));
		if (same) {
			keep.push({ id: spec.id, tags: currentTags });
		} else {
			patch.push({ id: spec.id, tags: wantedTags });
		}
	}
	return { create, patch, keep };
}

/**
 * 把服务端返回的 mental model 归一成注入需要的形状。
 * @param {Array} models 服务端模型列表。
 * @returns {Array<{id: string, name: string, content: string, tags: string[]}>}
 */
export function normalizeMentalModels(models) {
	const out = [];
	for (const model of models ?? []) {
		const id = typeof model?.id === "string" ? model.id : model?.mental_model_id;
		if (!id) continue;
		const content =
			typeof model?.content === "string"
				? model.content
				: typeof model?.text === "string"
					? model.text
					: "";
		out.push({
			id,
			name: typeof model?.name === "string" ? model.name : id,
			content: content.trim(),
			tags: Array.isArray(model?.tags) ? model.tags : [],
		});
	}
	return out;
}
