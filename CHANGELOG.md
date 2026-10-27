# Changelog

本插件的公共 API = **工具名**（`memory_*`）与 **配置键**（`Config` 里的字段）。
两者属于对外契约，变更即视为破坏性变更：先加新的、标旧字段 deprecated、下一 minor 再删。

版本策略（0.x 阶段）：0.x.y 中 x 递增代表契约变化，y 代表向后兼容的功能/修复。

## 0.8.1 — 写清「渲染预算让两端内容不等长」这件事

- 背景：0.8.0 让两端共用同一份精神模型后，「共用模型」与「两端看到同样多的字符」是两件事。omp 把正文渲染成 `<mental_models>` 块，受 `hindsight.mentalModelMaxRenderChars` 约束（默认 16000 字符，**在模型之间等分**，超了块尾出现 `…[mental-model snapshot truncated at render budget]`）；本插件的 `renderMentalModelMessage()` 不设预算、渲染全量。模型正文够长时 omp 会被截断、DSH 不会。
- 实测：7 个 `mem-*` bank 里有 6 个在默认 16000 下被截断；无截断所需最小预算 `mem-随便问问` 34000（4 个模型，最长一节 8199 字符）、`mem-新简历项目` 28000、`mem-universal-video-downloader` / `mem-enterprise-delivery-platform` 24000、`mem-毕设` / `mem-ecc-omp-fork` 20000、`mem-blog` 16000。
- 文档：README 新增「渲染预算：两端内容可能不等长」小节，写明两端的渲染差异、实测数字、以及要对齐内容时该调哪一侧。
- 契约未变：工具名与工具数量不变（仍 9 个 `memory_*`），配置键无新增，返回体无新增字段。**仅文档 + 版本号**。

## 0.8.0 — 精神模型与 omp 统一到同一份（取消 `dsh-` 前缀 + 注入过滤改为 scope 语义）

- 背景：0.7.x 的 `dsh-` 前缀是为「单 bank + 标签分栏」时代设计的避撞手段（那时所有项目共用一个 `shared` bank，omp 的 id 又会把纯中文项目名全部退化成 `project-conventions-project`，见 §25.4）。切到 `per-project`（每项目独占一个 bank）后这个约束消失了，前缀本身开始制造**重复注入**。
- 根因（源码级，omp 18.13.1）：omp 注入精神模型时**只按 scope 过滤、不按 id 过滤** —— `loadMentalModelsBlock` 传的是 `recallTags`，`per-project` 下为空 ⇒ **bank 里每个模型都被注入**。于是 omp 建的 `project-conventions` 与 DSH 建的 `dsh-project-conventions-<项目名>` 两份同语义模型同时进上下文。
- 实测症状（切换前）：`mem-随便问问` 的注入块 7 节，标题 `Project Conventions` 出现两次，块末尾出现 `[mental-model snapshot truncated at render budget]`（渲染预算 `hindsight.mentalModelMaxRenderChars` 默认 16000 字符被重复内容吃光）。
- 改 id 规则（`src/mental-models.js`）：复刻 omp 的 `deriveSeedId` —— `global`/`per-project` 用**裸 id**（`user-preferences` / `project-conventions` / `project-decisions`），`per-project-tagged` 用裸 id + 项目 slug 后缀（slug 规则也复刻 omp，只保留 ASCII、空则回落 `project`）。⇒ 两端共用同一份模型，服务端 LLM 少跑一半 refresh，注入上下文不再翻倍。
- 改注入过滤（`src/parity.js` + `src/index.js`）：从「id 白名单」改为与 omp 同规则的 **scope 过滤**（新增 `mentalModelVisible(model, scopeTags)`）。原来用 id 白名单 ⇒ **自定义模型（如手写的架构文档）在一端可见、另一端不可见**，同样是行为不对齐。
- 配置键 `mentalModelPrefix` 语义变更：默认 `"dsh"` → `""`（空 = 与 omp 完全同名）；保留为**可选隔离层**，填值就在 omp 的 id 前再加一层，用于「同一 bank 内两端必须用不同模型」的特殊场景。
- 契约变更：**配置键 `mentalModelPrefix` 的默认值变了**（`"dsh"` → `""`），且**默认行为下的 mental model id 变了**（`dsh-project-conventions-<项目名>` → `project-conventions`）。按 0.x 版本策略属契约变化 ⇒ 升 minor 到 **0.8.0**。工具名与工具数量不变（仍 9 个 `memory_*`），配置键无新增，返回体无新增字段。
- 数据迁移（本机一次性）：各 `mem-*` bank 删除 `dsh-*` 副本，并把同角色两份中**正文更长**的那份写进 omp 侧裸 id（走 `document-transfer`，因为 `POST /mental-models` 与 `PATCH` 都不接受 `content`）。结果 7 个 bank 各剩 3 个裸 id 模型、无 `dsh-` 残留。
- 验收：注入块从 7 节降到 4 节，标题 `Project Conventions` 只出现一次；单测 **121/121** 通过（新增 2 条：scope 可见性契约、id 默认与 omp 相同）。
- 保留的取舍：`per-project-tagged` 下中文项目名仍会退化（与 omp 一致）——这是 omp 自身的坑，DSH 不再单方面规避，规避会导致两端 id 不同、又回到重复注入的老路。单 bank 多中文项目应切 `per-project`。
- 装载提示：DSH 在启动时解析并缓存每个包的 `package.json`，装了 0.8.0 之后**必须重启 DSH Web** 才装载新代码。

## 0.7.4 — 文档对齐 per-project 布局 + 两条 per-project 口径的验证脚本

- 背景：本机 Hindsight 的作用域从「单库 `shared` + `project:` 标签分栏」改成「**每项目一个独立 bank**」（bank 基名 `mem`，bank 名 `mem-<项目目录名小写>`）。插件**无需任何代码改动**——`config.js` 的 `SCOPINGS` 本就内置 `global|per-project|per-project-tagged`，`parity.js` 的 `computeBankScope()` 与 omp 同算法，切作用域只改配置。
- 文档对齐：README 与 `docs/design.md` 里「`shared` 是库名不是前缀」「项目隔离靠标签」「只有切到 per-project 才会多出多个库」等段落全部改成当前实际布局，并写明代价（跨项目通用经验不再有单一真源）与回滚路径（改回 `bankId: shared` + `scoping: per-project-tagged` 即可，旧库完整保留）。「产出必须盖本项目标签」那条守则补上适用条件：`per-project` 下标签冗余但无害，保留它便于跨模式回退时仍可判层。
- 新增 `scripts/verify-live-per-project.mjs`：per-project 口径的活体自检（9 项）——目标 bank 存在且名为 `<base>-<项目名小写>`、MCP 握手、client 解析出的 bank 名正确、探针事实落进本项目 bank、**别的项目 bank 看不到（硬隔离负例）**、recall 命中、REST 与 MCP 两条传输都命中、探针事实作废。原有的 `scripts/verify-live.mjs` 仍按 `per-project-tagged` 口径，两者互补。
- 新增 `scripts/verify-dsh-runtime-e2e.mjs`：DSH 运行时端到端（10 项）——从 **`dsh --profile web --dump-config` 的真实合成输出**里解析出 `hindsight-memory` 的 config（而不是手工构造），喂给插件自己的 `normalizeConfig()` + `HindsightMemoryClient`，走 MCP 传输做一次真实写入，再做跨 bank 硬隔离负例与清理。这一步验证的是「DSH 运行时配置 → 插件代码 → 服务端落库位置」整条链路。
- 契约未变：工具名与工具数量不变（仍 9 个 `memory_*`），配置键无新增，返回体无新增字段；插件包只多两个 `scripts/` 下的验证脚本与 `package.json` 的两条 npm script 别名。
- 装载提示：DSH 在启动时解析并缓存每个包的 `package.json`，装了 0.7.4 之后**必须重启 DSH Web** 才装载新脚本（与 README 的既有说明一致）。

## 0.7.3 — 让"事实新旧排序"真正生效（0.7.2 那条修复是空转）

- 问题：0.7.2 把 `recency()` 的回退链改成 `mentioned_at` → `date` → `occurred_start` 优先，但 `findDuplicateGroups` 产出的成员对象只带出 `createdAt` / `updatedAt` 两个时间字段 ⇒ 新增的分支在真实链路上**永远取不到值**，没有 `updated_at` 的事实仍全部算成 0，「保留最新一条」依旧退化成原始顺序。配套的两条测试又直接手工构造了 `findDuplicateGroups` 不会产出的成员形状（把 `mentioned_at` 直接挂在 member 上），于是测试是绿的、修复是空的。
- 修：`findDuplicateGroups` 的成员映射补出 `mentionedAt` / `date` / `occurredStart`（服务端 `MemoryUnitListItem` 真实字段是 `updated_at` / `mentioned_at` / `date` / `occurred_start`，**没有 `created_at`**），`recency()` 同时认 `occurred_start` 与 `occurredStart`。
- 修测试：三条 `planPrune` 用例改为走真实链路（`findDuplicateGroups` → `planPrune`），用服务端形状的事实断言「保留的是最新那条」。修复前这两条用例失败（keep 拿到的是最旧那条），修复后通过。
- 契约未变：工具名与工具数量不变（仍 9 个 `memory_*`），配置键无新增，返回体无新增字段。
- 0.7.2 的另两条修复（`memory_operations action=delete` 走真删路由、看板文档数取 `/stats.total_documents`）经复核**不受影响，仍然有效**。

## 0.7.2 — 对齐 Hindsight 1.1 的服务端语义（operation 真删、文档数取 /stats、事实新旧排序）

- 背景：本机 Hindsight 从 1.0.0 升到 1.1.0。两版的 MCP 工具面与 REST 契约一致（`recall` 只多可选参数、`tags_match` 由字符串收窄为枚举、`prefer_observations` 改为可继承 bank 配置），**插件不需要为升级改任何代码**。这次升级把三处一直存在的老错用实机核对钉出来了。
- 修 `memory_operations action=delete`：服务端两条 DELETE 路由语义不同 —— `DELETE /operations/{id}` 是**取消**（任务已终态时返回 409），`DELETE /operations/{id}/delete` 才是**真删记录**（要求任务已终态）。插件原先只打第一条，于是对已完成任务必吃 409、对 pending 任务只是取消而那行还在 ⇒「清僵尸 pending 行」从来没真发生过。现在走「先取消（把 pending/processing 推到终态）再真删」两步，返回值新增 `cancelled` / `deleted` / `cancelError`。
- 修看板「0 份文档」：`/v1/default/banks` 的 bank 列表项**没有 document_count**（只有 fact_count），文档数只在 `/stats` 的 `total_documents` 里 ⇒ 面板恒显示 0 份文档。bank 概览现在在列表没给文档数时补打一次 `/stats`（列表若已带该字段则不补打），取不到只告警、不让概览整体失败。
- 修事实新旧排序：`recency()` 的回退链把 `created_at` 排在前面，而服务端 `MemoryUnitListItem` **没有 created_at**（只有 `updated_at` / `mentioned_at` / `date` / `occurred_start`）⇒ 没有 updated_at 的事实全部取到 0，同组里「保留最新一条」退化成原始顺序（可能保留最旧那条）。回退链改为 `mentioned_at` → `date` → `occurred_start` 优先。
- 契约未变：工具名与工具数量不变（仍 9 个 `memory_*`），配置键无新增；`memory_operations action=delete` 的返回体在原有字段之外新增 `cancelled` / `deleted` / `cancelError`。
- 兼容矩阵（本版本对两版服务端都成立，不要求先升 Hindsight）：`DELETE /v1/default/banks/{bank_id}/operations/{operation_id}/delete`（真删）与 `GET /v1/default/banks/{bank_id}/stats` 的 `total_documents` 在 **Hindsight 1.0.0 与 1.1.0 里都存在**（逐行核对两版 `api/http.py` 的路由与响应模型），所以这三条修复不引入「必须先升服务端」的新门槛。1.0.0 → 1.1.0 的破坏性面在**数据库迁移**（前向、不可回滚），不在 HTTP 契约。
- 装载提示：DSH 在启动时解析并缓存每个包的 `package.json`，装了 0.7.2 之后**必须重启 DSH Web** 才装载新代码（与 README 的既有说明一致）。

## 0.7.1 — 修看板通道注册失败（取 connection 必须 root 优先）

- 现象（活体复现）：插件详情页的「记忆看板」取数 405 —— `POST /dsh-hindsight-memory/overview` 报 Method Not Allowed，而同宿主其它通道（`/dsh-rewind/preview`）返回 401（路由存在、只是缺 cookie）。说明**通道压根没注册上**，不是鉴权问题。
- 根因（源码级）：宿主 `connection.rpc.handle(channel, handler)` 内部会执行 `owner.effect(() => owner.webServer.register(route))`，其中 `owner` 是**该 connection 实例自己的 ctx**。`scope.get("connection")` 拿到的是当前 fiber 视角下的实例，它的 ctx 解析不到 `webServer`，注册直接抛 `cannot get property "webServer" without inject`；`scope.root.connection` 拿到的实例其 ctx 能解析 webServer。v0.7.0 用了 `scope.get(...) ?? scope.root...` 的顺序 ⇒ 永远取到坏的那个。
- 修复：改成与 `dsh-rewind-plugin` 完全一致的 **`scope.root?.connection ?? scope.get?.("connection")`**（root 优先）。新增一条回归单测：构造"scope.get 返回会抛错的实例、scope.root 返回正常实例"的假 ctx，断言通道注册成功且通道名为 `/dsh-hindsight-memory`（共 108 条全绿）。
- 附带修复：看板在没有活跃会话时拿不到项目标签（`project` 层恒为 0、其余全落到"其它项目层"）⇒ 装载时预先按**进程 cwd** 解析一份兜底标签（与 omp 同规则：主 checkout 根 basename 小写），标签解析失败再回落配置项 `projectLabelOverride`。
- 活体验收（独立实例，未动用户实例）：`POST /dsh-hindsight-memory/overview` 带有效会话 cookie ⇒ **HTTP 200**，返回 `ok:true` 与完整快照（bank 539 条事实、全局层 131 / 项目层与其它项目层按标签正确归类、audit 计数、精神模型与知识页清单、公开配置 20 键）。
- 契约未变：工具名与工具数量不变（仍 9 个 `memory_*`），配置键无新增。

## 0.7.0 — 插件详情页记忆看板（只读）

- 新增：插件详情页多一个「记忆看板」区块，直接看当前记忆库状态——记忆库条数与告警、全局层/项目层/其它项目层分层与事实类型分布、近重复组、体检计数（陈旧/孤儿 observation/被取代/空知识页/卡住任务）、任务状态分布、精神模型与知识页清单（陈旧的会标出来），可手动刷新。
- 取数路径：服务端在宿主的 `connection.rpc` 通道上注册 `/dsh-hindsight-memory`（7 个**只读**端点：overview/layers/audit/operations/models/pages/config），client 半体注册 `plugins.detail.section` 席位并通过 `ctx.get("connection").rpc.call(...)` 取数。**为什么不让浏览器直连 Hindsight**：服务端没有 CORS 中间件（OPTIONS 预检直接 405），只能由服务端代理；宿主的 RPC 通道自带 Host/Origin 栅栏与会话 cookie 鉴权。
- **看板是只读的**：所有写操作仍必须走记忆工具（`memory_hygiene` / `memory_pages` / `memory_mental_models` 的 confirm+reason 护栏），页面不提供任何绕过护栏的写入口。端点清单里出现写动作时，单测直接失败。
- 新增文件：`src/panel.js`（纯函数快照组装 + 公开配置白名单）、`src/panel-rpc.js`（RPC 端点实现）、`test/panel.test.js`（契约测试）。
- 契约未变：工具名与工具数量不变（仍 9 个 `memory_*`），配置键无新增。
- 依赖：`dsh.client.inject` 增加 `@deepseek-ai/dsh-client-connection`（宿主自带，缺失时看板不可用但插件照常工作）。
- ⚠️ 需要**重启一次 DSH Web** 才能看到看板：宿主在启动时解析并缓存每个包的 `package.json` 与 client 半体。

## 0.6.5 — 修 observation 提示在活体里失效（分页信封当数组用）

- 现象（活体复现）：`memory_hygiene action=correct` 打派生 observation 时，报的不是可操作提示，而是 `整理失败：(facts ?? []) is not iterable`。
- 根因：`client.listFacts()` 返回的是服务端分页信封 `{items:[...], total, limit, offset}`，而 `describeSources()` 按数组遍历 ⇒ 一旦走到 observation 分支就抛 TypeError，v0.6.4 的结构化提示在真实环境**从未生效**（单测用的是摊平数组，没暴露）。
- 修复：`describeSources()` 兼容数组 / `{items:[...]}` / `{memories:[...]}` 三种形状，缺列表时返回空数组；在同一用例内补回归断言（92 条全绿）。
- 结论记录：这类"调用方形状不一致"的缺陷单测覆盖不到，**必须做活体验收**。v0.6.4 的新提示在活体里首次验证通过。

## 0.6.4 — observation 不可策展时给出可操作提示（附带源事实 id）

- 现场：`memory_hygiene action=correct` 打服务端直接回 `Hindsight HTTP 400: Memory 'xxx' is a observation; only world/experience facts can be curated.` —— 服务端只允许策展 world/experience，observation 是派生事实，改它没意义（会在下次 consolidation 重新派生）。旧版把这段原始 400 原样抛给使用者，看不出下一步该干什么。
- 现在 `memory_hygiene correct` 命中这类报错会转成结构化返回：`error="observation_not_curatable"` + 中文说明 + `sources[]`（该 observation 的源事实 id / tags / 正文摘要），直接告诉使用者「去改哪几条」。源事实通过新增的 `client.getFact()`（GET `/memories/{id}`）读取。
- 纯函数部分（`isObservationCurationError` / `describeSources`）落在 `src/maintenance.js`，不依赖服务端，可单测；新增 1 条契约测试（共 92 条全绿）。
- 洗账路径复核过一遍：过期事实 → 改它的**源 world 事实** → 服务端重嵌入并丢弃派生 observation → 触发 consolidate → 知识页快照重算。

## 0.6.3 — MCP 会话自愈（服务端重启不再让工具链永久失效）

- 修复：MCP 会话被服务端丢弃（容器重建 / session 过期）后，`initialized` 与 `mcp-session-id` 仍是旧值 ⇒ 后续每次调用恒定 404 `Session not found`，**整条工具链永久失效**，只能靠重启 DSH 恢复。
- 现在 `McpHttpClient.withSessionRetry()` 识别到会话失效就重置会话、重新握手并**重试一次**；`listTools` / `callTool` 都走这条路径。其它错误照常抛出，不做无谓重试。
- 现场证据：容器重建（`hindsight` Created 2026-10-22T08:10:18Z，保留 `hindsight-old` 供回滚）后，运行中的插件实例调 `memory_retain` 直接报 `MCP tools/call failed: HTTP 404 {"code":-32600,"message":"Session not found"}`。
- 验证：新增 `test/mcp-session.test.js`（2 条：假服务端先回 404 再回成功 ⇒ 断言重试一次 + 重新握手一次）；对**真实** Hindsight MCP 端点用过期 session id 实测 `get_bank` 成功返回 bank 内容。
- 工具名与工具数量不变（仍 9 个），纯修复。

## 0.6.2 — 把「超时到底是谁的」写进工具输出

- `memory_mental_models action=dry-run` 现在**自带结论**：失败时返回 `{ok:false,error:"dry_run_failed",hint}`，成功时也附 `hint`。
- 完整的三层超时链（实测）：① 客户端 deadline（此前 120s、现在 900s）→ ② Node 内置 fetch 的 300s 头超时（undici `headersTimeout`/`bodyTimeout` 默认 300000ms，Node v24.4.0 + undici 7.11.0 实测在 305s 断链）→ ③ 服务端 LLM 预算（env：LLM/mental-model-refresh 600s、reflect 墙钟 1800s）。
- ⇒ `dry-run-refresh`（服务端**同步**接口）对大模型必然失败；正确姿势是 `refresh`（异步返回 `operation_id`）→ `memory_operations` 轮询。工具描述里也写明这一点。

## 0.6.1 — 维护层超时对齐服务端预算

- **问题**：`memory_mental_models dry-run` / `refresh` 在服务端 LLM 繁忙时一律报「Hindsight 请求超时（120000ms）」。取证：容器 env `HINDSIGHT_API_LLM_TIMEOUT=600`、`HINDSIGHT_API_MENTAL_MODEL_REFRESH_LLM_TIMEOUT=600`、`HINDSIGHT_API_REFLECT_WALL_TIMEOUT=1800` —— **服务端自己允许跑 600s，客户端却只有 120s 的 deadline**，所以永远是我们先超时、服务端还在算。120s 是**客户端**上限，不是服务端上限。
- **修复**：新增配置 `maintenanceTimeoutMs`（默认 900000 = 15 分钟，上限 1800000），并把服务端 LLM 长任务（`dry-run-refresh` / `refresh` / `dry-run-extract`）与知识页、精神模型的增删改统一改用这个 deadline；`reflectTimeoutMs` 的可配上限从 600000 抬到 1800000（对齐服务端 reflect 墙钟）。
- **兜底语义**：新增 `timeout()` 解析器 —— 比下限还小的值**回落默认值**而不是夹到下限（把 10ms 夹成 1000ms 仍然是个必然超时的值，已知可用的默认值才是真兜底）。
- 工具名与工具数量不变（仍 9 个），只改了配置键 ⇒ 属于 0.x 的向后兼容修复。

## 0.6.0 — 维护层：记忆不只增

- `memory_hygiene` 新增五个动作：`audit`（只读体检）、`retract`（软退役）、`restore`（恢复）、`correct`（改写正文）、`supersede`（新事实取代旧事实）。
- `memory_pages` 新增 `update`（改标题 / 取数问题 / 标签 / 上下文上限）与 `delete`（删页，**不可逆**）。
- `memory_mental_models` 新增 `delete`（删模型）、`clear`（清空内容）、`dry-run`（预演刷新，不落库）。
- 已知的服务端侧限制：`memory_mental_models dry-run` 走服务端 LLM 刷新，实测在服务端繁忙时会 120s 超时（与那批长期 `processing` 的 `refresh_mental_model` 同源，属服务端刷新能力的问题，不是工具逻辑错误）。
  **工具总数仍为 9、公共 API 的工具名不变**——维护并入既有工具，不新增入口。
- 新增 `src/maintenance.js`：体检与补丁生成全是纯函数（可单测），`guardAction` 统一把「缺确认/缺理由」的请求拦在落手之前。
- 破坏性动作护栏：缺 `confirm=true` ⇒ `{ok:false,error:"confirm_required"}`；缺 `reason` ⇒ `{ok:false,error:"reason_required"}`。
- 退役可逆：服务端事实没有 DELETE 端点，只有 `state:"invalidated"` 软退役，`restore` 可改回 `valid`。
- 新增配置：`maintenanceStaleDays`（180）、`maintenanceStuckMinutes`（30）、`maintenanceRequireConfirm`（true）。
- 修复 `src/hygiene.js` 的 `recency()`：此前只读下划线时间键，而去重成员用驼峰键，导致「保留最新一条」实际保留的是扫描序第一条（静默偏差）。
- `src/client.js` 补齐维护用接口：`updateFact`/`setFactStateWithReason`/`factHistory`/`dryRunExtract`/`updateKnowledgeNode`/`deleteKnowledgeNode`/`deleteMentalModel`/`clearMentalModel`。

## 0.5.0 — 知识页与 initiative

- 新增 `memory_pages`（list/search/read/create）与 `memory_initiative`（capture/list）两个工具。
- 服务端原生能力（`/knowledge-base`）的客户端封装：知识页可读、可建；initiative = 知识页 + 一条记忆标记。
- 新增配置：`knowledgePages`、`pageSearchLimit`、`pageMaxTokens`、`initiativeFolder`。
- 工具总数 7 → 9。

## 0.4.0 — 对齐 omp 接入报告

- 新增 `memory_mental_models`（ensure/list/content/refresh/patch）与 `memory_operations`（list/retry/delete）。
- `memory_hygiene` 增加 `scope` 与 `action=layers`；`memory_status` 增加分层明细、运维观测、bank 概览与空 bank 警告。
- 写入侧补齐 omp 的写入契约：本地时区 `timestamp` + `metadata.session_id`；自动留存按 `retainEveryNTurns` 限流。
- 精神模型 id 全局唯一且不 ASCII 过滤（中文项目名不再退化）；`max_tokens` 下限 256（服务端硬门槛）。

## 0.3.0 — 修「插件行没有可编辑配置项」

- `Config` 改为 `LiveConfig`：全部字段 `.volatile()`，宿主 settings 描述符才会产出可编辑表单。

## 0.2.0 — 记忆卫生

- 新增 `memory_hygiene`（preview/prune/consolidate/scopes/strategies-preview）：类型感知的近重复识别、软退役、服务端归纳整理。
- 同步配置 bank 级 `consolidation_strategies` / `observations_mission` / `max_observations_per_scope`。

## 0.1.0 — 首个可用版本

- `memory_recall` / `memory_retain` / `memory_reflect` / `memory_status` 四个工具。
- 单 bank + 双层标签（无 tag = 全局层，`project:<仓库目录名小写>` = 项目层），与 omp 的 `per-project-tagged` 语义逐字对齐。
- 自动召回注入（`agent/pre-step`，落在缓存前缀之后）、自动留存（`agent/turn-stopping`）。
