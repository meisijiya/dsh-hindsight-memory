# DSH 宿主机制笔记（host notes）

> 这些是**宿主平台怎么用**的知识，不是本项目的业务事实。
> 它们不写进 Hindsight 记忆库（记忆库只放项目事实与跨项目约定），只留在这里随代码走版本控制。
> 来源：2026-10-22 从本地 Mnemon 运行时记忆分流而来（原件仍在 `C:\Users\22923\.mnemon\runtime\`）。

## 1. DSH Web GUI 的鉴权是自签 cookie（可自行铸造）

- GUI 地址 `http://127.0.0.1:3080` 未带 cookie 时返回 401 纯文本 `dsh web authentication required; reopen the URL printed by dsh web.`
- cookie 名 = `dsh-auth-` + `base64url(sha256(authority))`，`authority` = `host:port`（本机 = `127.0.0.1:3080`）
- cookie 值 = `v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, body))>`
  - `payload` = `{version:1, authority, issuedAt, expiresAt}`（毫秒时间戳），`body` = `base64url(JSON.stringify(payload))`
  - **HMAC 必须签 base64url 后的 body 字符串**，不是原始 JSON（签错就 401）
  - `secret` 取 `C:\Users\22923\.dsh\.credentials.yaml` 的 `records.client-connection/browser-session.payload.secret`（base64url，解码后 32 字节）
- 服务端校验：`dsh-client-connection/lib/index.js:317-400`（encodeCookie/decodeCookie）、`:568` 校验 `expiresAt - issuedAt <= maxAgeDays`
- 用法：ego-browser `page.cdp("Network.setCookie", {name, value, url:"http://127.0.0.1:3080/", path:"/", httpOnly:true, sameSite:"Strict"})`

## 2. DSH 插件缓存稳定性三条铁律（工具 schema 在缓存前缀内）

- 工具 schema 进入 `canonicalHeader({config, adapterDefaults, tools})` ⇒ **增删工具或改 schema 会让请求头变化 → 缓存前缀失效**。
  - `dsh-agent-loop/lib/index.js:1214-1241`；`:1056-1060` 的 `startsSeries` 判定。
  - 适配器能力位：`systemPromptUpdate: "in-history"`、`toolUpdate: "in-history" | "addition-only"`（`dsh-llm/lib/index.js:2125-2128`）。
- `systemPrompt.section()` 的 text **每次 assemble 都会重求值** ⇒ 常驻提示必须字节稳定（禁用时返回空串，不要放时间戳/记忆内容）。
  - `dsh-system-prompt/lib/index.js:253`（section）、`:356`（assemble）；每步装配点 `dsh-agent-loop/lib/index.js:907`。
  - 变化的内容走 `systemPrompt.context()` 或 user message（落在缓存边界之后）。
- 工具要**在 apply 时一次性注册**，不要每轮注册；`ctx.tools.register()` 重名会抛。
  - `dsh-tools/lib/index.js:2974`（register，要求 `output.render`）。
- 宿主自身范例：`dsh-mnemon/lib/index.js:7890-7931` 用字节相同的兜底常量保证提示不变。

## 3. 客户端半体（client bundle）装好后必须重启 DSH 才可见

- 宿主在**启动时**解析各插件的 `package.json`（`dsh.client` + `exports["./client"]`）并合成 client bundle 组合（`dsh-client-modules/lib/index.js` 的 compose 表，由 `internal/plugin` 事件驱动 dirty→flush→compose）。
- 运行中改磁盘上的 `package.json` **不会**自动生效；只有插件 fiber 构造/销毁才重算 ⇒ 面板不出现时先重启，而不是反复点开关。
- 症状：`GET /plugins/<id>/client.js` 返回 404（该插件的 client bundle 不在组合里）。
- 本机额外限制：**通用配置表单不可用**（`GET /api/settings/describe` = 404，所有插件详情页只有「打开配置文件」按钮）；
  可用的 client slot：`plugins.detail.section` / `plugins.detail.actions` / `plugins.detail.badge` / `plugins.bundle.config` / `plugins.row.config` / `plugins.item` / `plugins.tab`。
  ⇒ 自建可视面板的正确路径是 `plugins.detail.section` + 插件自建 HTTP 端点（`dsh-mnemon` 的 `/dsh-mnemon-settings/get` 是范例）。

## 4. DSH 插件市场投稿规范（awesome-dsh-plugin）

- 投稿 = **只加一个文件** `data/plugins/<owner>__<repo>.yml`；`README.md` / `README.zh.md` 由脚本生成，不要手改（本地 `npm ci && node scripts/generate-readme.mjs` 重新生成后一起提交）。
- yml 必填：`url`（与仓库完全一致）、`name`（`owner/repo`）、`category`（`memory` 等）、`description.en`（一句英文，以句号结尾；含 `: ` 必须加引号）。
- 仓库硬性要求：package.json 必须声明 **`dsh.bundle` manifest**（`{"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}`）；只声明 `dsh.client` 会被 CI 拒。
- 其它：仓库创建满 1 天（CI 自动查）、要有 `dsh-plugin` topic、一个 PR 最多 3 条、可选 `tarball` 钉 tag。
- CI 检查顺序：每 PR ≤3 条 → 抓仓库 package.json 验 dsh.bundle → 仓库年龄 ≥1 天 → awesome-lint + 站点构建。
- 依赖约定（与本机既有插件一致）：宿主相关包放 `peerDependencies`（范围要带显式预发布分支，如 `">=0.2.1-rc.1 <0.3.0-0"`），纯工具库可放 `dependencies`。
