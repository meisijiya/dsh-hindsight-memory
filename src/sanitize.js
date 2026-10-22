/**
 * 写入前的文本净化。
 *
 * 目的有两个：
 *  1. **可判层**：一条记忆如果混进"噪声标签"（比如把别家 Provider 自动加的
 *     `source:`/`harness:` 标签原样带进来），omp 侧按 project 过滤时就看不见它
 *     （实测：只带 `[source:chat,harness:dsh]` 的事实在 omp 的
 *     `tags=[project:x] + any` 召回里不可见）。所以**写的时候只发我们自己的标签**。
 *  2. **去会话噪声**：operation_id、临时路径、时间戳这类每次都不同的东西写进记忆，
 *     会让"同一件事"产生多条互相矛盾的记录，也会让跨 agent 检索时召回一堆垃圾。
 */

const VOLATILE_PATTERNS = [
	/\boperation[_ -]?id\b\s*[:=]\s*[0-9a-f-]{8,}/gi,
	/\bsession[_ -]?id\b\s*[:=]\s*[0-9a-f-]{8,}/gi,
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
];

/**
 * 净化记忆正文。
 * @param {string} text
 * @returns {string}
 */
export function sanitizeMemoryText(text) {
	let out = String(text ?? "");
	for (const pattern of VOLATILE_PATTERNS) out = out.replace(pattern, "").replace(/[ \t]{2,}/g, " ");
	return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 校验并归一化写侧标签。
 *
 * 🔴 铁律：**只允许我们自己的标签**。任何 `source:` / `harness:` 前缀的标签都丢掉
 *    ——它们是别人的 provenance 标记，带上会让 omp 的 project 过滤失效。
 *
 * @param {string[]|string|undefined} tags
 * @returns {string[]}
 */
export function sanitizeTags(tags) {
	const list = Array.isArray(tags)
		? tags
		: typeof tags === "string"
			? tags.split(",")
			: [];
	const out = [];
	for (const raw of list) {
		const tag = String(raw ?? "").trim();
		if (!tag) continue;
		if (/^(source|harness):/i.test(tag)) continue;
		if (!out.includes(tag)) out.push(tag);
	}
	return out;
}

/**
 * 归一化模型传来的 scope 字符串。
 * @param {unknown} scope
 * @param {string} fallback
 */
export function normalizeScope(scope, fallback) {
	const value = String(scope ?? "").trim().toLowerCase();
	if (value === "project" || value === "project_only" || value === "global") return value;
	return fallback;
}
