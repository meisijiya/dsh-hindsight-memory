# Changelog

本插件的公共 API = **工具名**（`memory_*`）与 **配置键**（`Config` 里的字段）。
两者属于对外契约，变更即视为破坏性变更：先加新的、标旧字段 deprecated、下一 minor 再删。

版本策略（0.x 阶段）：0.x.y 中 x 递增代表契约变化，y 代表向后兼容的功能/修复。

## 0.6.0 — 维护层：记忆不只增

- `memory_hygiene` 新增五个动作：`audit`（只读体检）、`retract`（软退役）、`restore`（恢复）、`correct`（改写正文）、`supersede`（新事实取代旧事实）。
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
