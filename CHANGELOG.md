# Changelog

本插件的公共 API = **工具名**（`memory_*`）与 **配置键**（`Config` 里的字段）。
两者属于对外契约，变更即视为破坏性变更：先加新的、标旧字段 deprecated、下一 minor 再删。

版本策略（0.x 阶段）：0.x.y 中 x 递增代表契约变化，y 代表向后兼容的功能/修复。

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
