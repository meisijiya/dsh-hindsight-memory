/**
 * 最小 MCP streamable-http 客户端（零依赖）。
 *
 * 为什么自己写而不是装 SDK：
 *   - 官方 SDK 的包名在本机 DSH 安装里是 `@modelcontextprotocol/client`（2.2.0），
 *     而 npm 上的公开包是 `@modelcontextprotocol/sdk`；两者行为与导出不一致，
 *     插件如果依赖它，profile 重新装包时可能就装不上。
 *   - 我们只需要 4 个动作：initialize / tools/list / tools/call。
 *   - 插件必须能被**任何**安装形态加载（包括 file:// 直接加载），
 *     所以本文件只用 Node 内置模块。
 *
 * 协议要点（已在真实 Hindsight 服务上验证）：
 *   - POST {url}，头 `Accept: application/json, text/event-stream`、
 *     `Content-Type: application/json`。
 *   - initialize 的响应头里有 `mcp-session-id`，后续请求必须带回去；
 *     不带会被服务端 404 `{"error":{"code":-32600,"message":"Session not found"}}`。
 *   - 响应可能是纯 JSON，也可能是 SSE（`data: {...}` 逐行）。
 */

const JSONRPC_VERSION = "2.0";

/** 从 SSE 文本里抽出所有 data: 行拼成的 JSON。 */
function parseSse(text) {
	const chunks = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			chunks.push(JSON.parse(payload));
		} catch {
			/* 忽略非 JSON 行 */
		}
	}
	return chunks;
}

export class McpError extends Error {
	constructor(message, { code, data } = {}) {
		super(message);
		this.name = "McpError";
		this.code = code;
		this.data = data;
	}
}

/**
 * 服务端把会话丢掉（容器重启、session 过期）时，后续请求会拿到
 * 404 `Session not found`。这是**可自愈**的：重新握手一次即可，
 * 不该让整条工具链因为一次服务端重启而永久失效。
 */
export function isSessionLost(error) {
	const text = String(error?.message ?? "");
	return /session not found/i.test(text) || /session (?:has )?expired/i.test(text);
}

export class McpHttpClient {
	/**
	 * @param {object} options
	 * @param {string} options.url MCP 端点，例如 http://127.0.0.1:8888/mcp/shared/
	 * @param {Record<string,string>} [options.headers]
	 * @param {number} [options.timeoutMs]
	 * @param {(msg: string) => void} [options.log]
	 */
	constructor({ url, headers = {}, timeoutMs = 60_000, log = () => {} }) {
		this.url = url;
		this.headers = headers;
		this.timeoutMs = timeoutMs;
		this.log = log;
		this.sessionId = null;
		this.initialized = false;
		this.nextId = 1;
		this.tools = null;
	}

	/** 单次 JSON-RPC 往返。 */
	async request(method, params, { signal } = {}) {
		const body = { jsonrpc: JSONRPC_VERSION, id: this.nextId++, method };
		if (params !== undefined) body.params = params;

		const headers = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...this.headers,
		};
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const response = await fetch(this.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			const sessionId = response.headers.get("mcp-session-id");
			if (sessionId) this.sessionId = sessionId;

			const text = await response.text();
			if (!response.ok) {
				throw new McpError(`MCP ${method} failed: HTTP ${response.status} ${text.slice(0, 300)}`, {
					code: response.status,
				});
			}
			const messages = parseSse(text);
			if (messages.length === 0 && text.trim()) {
				try {
					messages.push(JSON.parse(text));
				} catch {
					/* 交给下面的空响应处理 */
				}
			}
			const payload = messages.find((m) => m && m.id === body.id) ?? messages[0];
			if (!payload) throw new McpError(`MCP ${method}: empty response`);
			if (payload.error) {
				throw new McpError(`MCP ${method}: ${payload.error.message ?? "unknown error"}`, {
					code: payload.error.code,
					data: payload.error.data,
				});
			}
			return payload.result;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/** 初始化握手（幂等）。 */
	async initialize({ signal } = {}) {
		if (this.initialized) return;
		await this.request(
			"initialize",
			{
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "dsh-hindsight-memory", version: "0.1.0" },
			},
			{ signal },
		);
		// 通知服务端：初始化完成（notification，无 id）。
		await this.notify("notifications/initialized", {}, { signal });
		this.initialized = true;
	}

	async notify(method, params = {}, { signal } = {}) {
		const headers = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...this.headers,
		};
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		signal?.addEventListener("abort", () => controller.abort(), { once: true });
		try {
			await fetch(this.url, {
				method: "POST",
				headers,
				body: JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params }),
				signal: controller.signal,
			});
		} catch (error) {
			// 通知失败不致命：服务端对 initialized 通知是宽容的。
			this.log(`MCP notify ${method} failed: ${error?.message ?? error}`);
		} finally {
			clearTimeout(timer);
		}
	}

	/** 丢掉当前会话（服务端重启/过期后重新握手用）。 */
	resetSession() {
		this.sessionId = null;
		this.initialized = false;
		this.tools = null;
	}

	/**
	 * 执行一次请求；遇到会话失效就重连并重试一次。
	 * 只有「会话失效」才重试，其它错误照常抛出。
	 */
	async withSessionRetry(run) {
		try {
			return await run();
		} catch (error) {
			if (!isSessionLost(error)) throw error;
			this.log(`MCP 会话失效（${error?.message ?? error}），重新握手后重试一次`);
			this.resetSession();
			await this.initialize();
			return run();
		}
	}

	/** 列出服务端工具（带缓存）。 */
	async listTools({ signal, refresh = false } = {}) {
		if (this.tools && !refresh) return this.tools;
		return this.withSessionRetry(async () => {
			const result = await this.request("tools/list", {}, { signal });
			this.tools = Array.isArray(result?.tools) ? result.tools : [];
			return this.tools;
		});
	}

	/** 调用工具；会话失效时自动重连并重试一次。 */
	async callTool(name, args = {}, { signal } = {}) {
		await this.initialize({ signal });
		return this.withSessionRetry(() => this.request("tools/call", { name, arguments: args }, { signal }));
	}
}
