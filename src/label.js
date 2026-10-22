/**
 * 项目标签解析。
 *
 * 🔴 这是"与 omp 行为一致"最容易出错的一环，必须逐条复刻 omp 的规则：
 *
 *   omp（packages/coding-agent/src/hindsight/bank.ts）：
 *     function projectLabel(directory: string): string {
 *       if (!directory) return UNKNOWN_PROJECT;                       // "unknown"
 *       const primary = vcs.repo(directory)?.primaryRoot() ?? null;
 *       return path.basename(primary ?? directory).toLowerCase() || UNKNOWN_PROJECT;
 *     }
 *
 *   即：**主 checkout 根目录的 basename，转小写**。
 *   - 不是 cwd 的 basename（cwd 可能是子目录）；
 *   - 不是原始大小写（`General` ⇒ `general`）——
 *     因为 Hindsight 的 tag 匹配是**字面**匹配，大小写不一致就等于两个项目互相看不见。
 *   - 仓库解析失败时回落到 cwd basename；再失败才用 "unknown"。
 *
 * 本机环境没有 omp 的 native VCS 适配器，用 git 命令行等价实现：
 *   - `git rev-parse --path-format=absolute --git-common-dir`
 *     对**普通克隆**给出 `<repo>/.git`；对**linked worktree** 给出**主仓库**的 .git
 *     （这正是 omp `primaryRoot()` 的语义：worktree 共享主 checkout 的身份）。
 *   - 取该目录的父目录作为主 checkout 根；裸仓库则直接用该目录。
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** omp 的兜底标签。 */
export const UNKNOWN_PROJECT = "unknown";

/** 目录 ⇒ 主 checkout 根 的缓存（git 调用不便宜，但一个目录只查一次）。 */
const rootCache = new Map();

/**
 * 解析主 checkout 根目录。
 *
 * @param {string} directory 工作目录。
 * @returns {Promise<string|null>} 主 checkout 根；解析不出来返回 null。
 */
export async function resolvePrimaryRoot(directory) {
	if (!directory) return null;
	const cached = rootCache.get(directory);
	if (cached !== undefined) return cached;

	let root = null;
	try {
		const { stdout } = await execFileAsync(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ cwd: directory, timeout: 5_000, windowsHide: true },
		);
		const common = stdout.trim();
		if (common) {
			// `<repo>/.git` ⇒ 主 checkout 根 = 其父目录；裸仓库目录直接用自身。
			root = path.basename(common) === ".git" ? path.dirname(common) : common;
		}
	} catch {
		// 老版本 git 不支持 --path-format，退回 --git-common-dir（相对路径按 cwd 解析）。
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
				cwd: directory,
				timeout: 5_000,
				windowsHide: true,
			});
			const common = stdout.trim();
			if (common) {
				const abs = path.isAbsolute(common) ? common : path.resolve(directory, common);
				root = path.basename(abs) === ".git" ? path.dirname(abs) : abs;
			}
		} catch {
			root = null;
		}
	}
	if (root === null) {
		// 再退一步：--show-toplevel 至少能给当前工作树（linked worktree 会与主 checkout 不同名，
		// 但总比没有强）。
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
				cwd: directory,
				timeout: 5_000,
				windowsHide: true,
			});
			const top = stdout.trim();
			if (top) root = top;
		} catch {
			root = null;
		}
	}
	rootCache.set(directory, root);
	return root;
}

/**
 * 计算项目标签（与 omp 同规则）。
 *
 * @param {string} directory 工作目录。
 * @param {string} [override] 显式覆盖（配置项 projectLabelOverride）。
 * @returns {Promise<string>} 小写标签；无法判定时为 "unknown"。
 */
export async function resolveProjectLabel(directory, override = "") {
	if (typeof override === "string" && override.trim()) return override.trim().toLowerCase();
	if (!directory) return UNKNOWN_PROJECT;
	const root = await resolvePrimaryRoot(directory);
	const base = path.basename(root ?? directory);
	return (base || UNKNOWN_PROJECT).toLowerCase();
}

/** 纯函数版：给已知根目录算标签（测试用，也供上层在已持有根时免去 git 调用）。 */
export function projectLabelFromRoot(rootOrDirectory) {
	if (!rootOrDirectory) return UNKNOWN_PROJECT;
	const base = path.basename(rootOrDirectory);
	return (base || UNKNOWN_PROJECT).toLowerCase();
}

/** 测试用：清空缓存。 */
export function resetLabelCache() {
	rootCache.clear();
}
