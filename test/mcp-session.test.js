import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { McpHttpClient, isSessionLost } from "../src/mcp.js";

test("isSessionLost 只认会话失效类错误", () => {
	assert.equal(isSessionLost(new Error("MCP tools/call failed: HTTP 404 Session not found")), true);
	assert.equal(isSessionLost(new Error("boom")), false);
	assert.equal(isSessionLost(undefined), false);
});

test("会话失效时自动重连并重试一次", async () => {
	let calls = 0;
	let sessions = 0;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const msg = JSON.parse(body || "{}");
			if (msg.method === "initialize") {
				sessions += 1;
				res.writeHead(200, { "content-type": "application/json", "mcp-session-id": `s${sessions}` });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18" } }));
				return;
			}
			if (msg.method === "notifications/initialized") {
				res.writeHead(202).end();
				return;
			}
			calls += 1;
			if (calls === 1) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "Session not found" } }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	const client = new McpHttpClient({ url: `http://127.0.0.1:${port}/mcp/shared/` });
	const result = await client.callTool("retain", { content: "x" });
	assert.equal(result.content[0].text, "ok");
	assert.equal(calls, 2, "第一次失败后应重试一次");
	assert.equal(sessions, 2, "应重新握手一次");
	server.close();
});
