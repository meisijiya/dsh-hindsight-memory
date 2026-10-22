---
id: "fc80fc27-c0d3-4d42-baeb-858401a3c5c1"
title: "DSH ⇄ omp 统一记忆插件 dsh-hindsight-memory（对齐中间层）· 设计与验收"
description: "把 Hindsight MCP 封装成 DSH 插件、用中间层强制对齐 omp 记忆行为的完整设计与验收：omp 行为契约基线表（14 项逐条对齐）、DSH 缓存稳定性机制（工具 schema 在缓存前缀、提示词段必须常量、变化内容走用户消息）、活体验收证据（装载/写侧标签/omp 反向可见/跨项目隔离负例/8 项自检）、安装与灰度回滚。代码在 D:\\26code\\随便问问\\dsh-hindsight-memory\\。"
status: "active"
created_at: "2026-10-22T03:43:56.251Z"
updated_at: "2026-10-22T03:43:56.251Z"
content_hash: "5ae9b12f52c3db82dcc2ee86d5afa9407edde3b7c9f7ce3186f478580afdc510"
source_paths:
  - "dsh-hindsight-memory/src"
  - "dsh-hindsight-memory/docs/design.md"
  - "dsh-hindsight-memory/README.md"
  - "dsh-hindsight-memory/cordis.patch.yml"
session_ids:
  - "session-43883589-ddc1-421b-b98b-e8eb4ba66b78"
memory_body_ids:
  []
---

# DSH ⇄ omp 统一记忆插件（dsh-hindsight-memory）· 设计与验收 r1

> 2026-10-22。目标：把 Hindsight MCP 封装成 DSH 插件，用**中间层**强制放行写与读，让 DSH 与 omp 的记忆行为完全一致；模型只看见封装好的工具，不直接用裸 MCP 工具；工具说明常驻系统提示词但字节稳定，不让缓存频繁失效。

## A. 为什么需要这层插件

现状是两端各写各的：

- **DSH**：dsh-mnemon 的 Hindsight provider。写侧能把 `tags` 逐字落库（可写无标签全局层）；**读侧不能按项目过滤**——provider 0.5.6（npm 最新）的 `search()` 请求体写死 `{query,budget,max_tokens,types,prefer_observations}`，没有 `tags`/`tags_match`，descriptor 也只有 `endpoint/apiKey/bankId/budget` 四个字段 ⇒ 读的是整库。
- **omp**：官方原生 Hindsight 后端。读侧按 `project:<label>` 过滤，但它的 retain **恒带**项目标签 ⇒ omp 自己产不出无标签的全局层。

两边规则不统一 ⇒ 写着写着互相看不见。插件要做的事就一件：**把"模型说的话"翻译成"omp 也会做的同一件事"**——同一个 bank、同一套标签语义、同一套分层、同一套过滤。

## B. 架构

```
DSH 模型 ──▶ memory_recall / memory_retain / memory_reflect / memory_status
                   │  插件盖章（模型碰不到 tags / bankId）
                   ▼
             Hindsight bank `shared`
                   ▲
                   │  omp 原生后端（自动盖章 + 自动过滤）
                 omp
```

代码：`D:\26code\随便问问\dsh-hindsight-memory\`（零运行时依赖，纯 ESM）

- `src/index.js` — 插件入口：注册 4 个工具、注入常量提示词段、首回合自动召回、回合结束自动留存
- `src/parity.js` — 与 omp 同构的纯函数：银行作用域、标签、召回过滤、query 截断
- `src/label.js` — 项目标签解析（复刻 omp 的 `primaryRoot().toLowerCase()`）
- `src/client.js` — 双传输客户端（REST / MCP streamable-http）
- `src/prompt.js` — 常量提示词段 + `<memories>` 注入块渲染
- `src/sanitize.js` — 内容与标签消毒（丢弃 `source:`/`harness:` provenance 标签，否则 omp 过滤失效）
- `src/config.js` — 配置归一化（**非法输入一律回落默认值，绝不抛错**，避免炸 profile）
- `test/` — 18 个单测；`scripts/verify-live.mjs` — 8 项活体自检
- `docs/design.md` — 完整设计（458 行）

## C. omp 行为契约基线（对齐验收表）

| # | 契约 | omp 事实 | 本插件 | 状态 |
|---|---|---|---|---|
| 1 | 银行基名 | `hindsight.bankId`（默认 `omp`），`bankIdPrefix` 非空则 `prefix-base` | 同构可配，默认 `shared` | ✅ |
| 2 | 作用域 | `global`/`per-project`/`per-project-tagged`（默认） | 同构可配 | ✅ |
| 3 | 项目标签 | `basename(主 checkout 根 ?? cwd).toLowerCase()`，失败回落 `unknown` | `git rev-parse --git-common-dir` 复刻 `primaryRoot()` | ✅ 实测 `随便问问` |
| 4 | 写入标签 | per-project-tagged 恒带 `project:<label>` | `tier=project`→带；`tier=global`→`[]` | ✅ 实测落库一致 |
| 5 | 召回标签 | 仅 per-project-tagged 发 `tags`+`tags_match=any` | 同构 | ✅ |
| 6 | 召回类型 | `["world","experience"]` | 同值 | ✅ |
| 7 | 召回预算 | `mid` | 同值 | ✅ |
| 8 | 召回 token | `1024` | 同值 | ✅ |
| 9 | reflect | 只发 `{query,budget:"low"}` | `reflectBudget` 默认 `low` | ✅ |
| 10 | query 截断 | `800`，保留尾部 | `truncateQuery()` 同规则 | ✅ |
| 11 | 注入形状 | `<memories>` 背景块，条目 `- <text> [type]` | 同构形状（载体是 DSH 用户消息） | ⚠️ 载体差异 |
| 12 | 自动召回 | 只首个模型回合触发一次，**结果持久化进 session 文件** | 触发一次，仅存内存 | ⚠️ resume 会重查 |
| 13 | 自动留存 | `retainEveryNTurns=3`；full-session 不切块、整段重发、`document_id=sessionId` | 本回合文本简化版 | ⚠️ 简化 |
| 14 | 子 agent | 复用父级 client/bank/标签，**不**自动召回/落盘 | `agent.parentAgent` 存在即跳过 | ✅ |

## D. 缓存稳定性（DSH 官方机制）

- **工具 schema 在缓存前缀里**：`canonicalHeader({config, adapterDefaults, tools})`；工具集合变 ⇒ 请求头变 ⇒ `startsSeries` ⇒ 在没有 `toolUpdate` 能力的适配器上**缓存作废**。
- 系统提示词是 surface node 0：适配器无 `systemPromptUpdate:"in-history"` 时，文本一变就**替换头部并清空后续节点** ⇒ 缓存断裂。
- section 每次 assemble（每一步）都重新求值 ⇒ **只有常量字符串能字节稳定**；变化内容走 `systemPrompt.context()` 或**用户消息**（落在缓存边界之后）。

据此的四条铁律（本插件全部遵守）：① 工具**只在装载时注册一次**；② 提示词段是**编译期常量**，关闭时返回空串而非换文本；③ 变化内容一律走用户消息；④ 绝不改共享配置对象（宿主侧是 `deepFreeze(structuredClone(...))`）。

踩坑备忘：`section.order` 必须是字面数字（`getSectionOrder("自定义键")` 返回 undefined ⇒ 插件装不上）；`interpolate:false` 必须显式写（否则 `{{var}}` 插值抛错、整轮请求报废）；`system-prompt/assemble` 瀑布必须 `await next()`（否则静默清空其它插件的 prompt 贡献）；整体替换 `result.sections` 会丢 `interpolate` 标志，必须就地改 `section.text`。

## E. 验收证据（2026-10-22 真实执行）

1. **装载**（`dsh headless --patch`，不碰用户 profile）：工具全部注册，`bank=shared`、`projectLabel=随便问问`、召回 13 条命中真实事实。
2. **写侧标签**：`memory_retain` 两次 → `tier=project` 落库 `["project:随便问问"]`，`tier=global` 落库 `[]`；服务端 `results[]` 复核逐字一致。
3. **omp 反向可见**：本仓库 `omp -p` 同时召回项目层与全局层两条，bank=`shared`。
4. **跨项目隔离**：服务端探针 `tags=[project:blog]`+any → 31 条里 PARITY-P7X3 只剩 2 条**无标签全局层**；`any_strict` → 0 条。`blog` 仓库里 `omp -p`（HINDSIGHT_DEBUG=1）召回 15 条**全部无标签**（`matchedUntagged=15, matchedTagged=0`），项目层不可见。
5. **插件自检**：`node scripts/verify-live.mjs` → **8/8 通过**（MCP 握手、project scope 混合可见、project_only 纯净、global 纯净、**别项目标签硬隔离负例 count=0**、REST banks、REST/MCP 同批、探针自动作废）。
6. **单测**：18/18 通过。

⚠️ **一次误读的教训**：blog 场景第一次 `omp -p`（无 debug）模型回答"看到了带 project:随便问问 的条目"，被服务端探针与带 debug 的复跑证伪。⇒ **隔离行为以服务端 API 探针为准，模型自述不算证据。**

## F. 安装与回滚

```bash
dsh plugin --profile web add "D:/26code/随便问问/dsh-hindsight-memory"   # 需重启 DSH（会中断当前会话）
dsh plugin --profile web remove dsh-hindsight-memory                     # 回滚
```

包声明 `dsh.bundle.patch: "./cordis.patch.yml"` ⇒ 走 bundle 路线，profile 装载时自动组合插件 patch 行；改配置只需改 profile 的 `cordis.patch.yml` 里那一行 `config`。

灰度顺序（每步可回滚）：① `writeEnabled:false` 只读挂载 → ② 打开写、只用手动 `memory_retain` → ③ 打开 `autoRecall` → ④ 打开 `autoRetain`。

## G. 顺带发现的两个问题（未处理，待定夺）

1. **旧插件 omp-memory-dsh 是死桥**：`~/.omp/agent/memories/` 下已无 `learned.md`（omp 切 Hindsight 后端），而 `~/.dsh/profiles/web/cordis.patch.yml:728-736` 仍以 `enabled: true` 挂载它 ⇒ 写进去的记忆 omp 永远读不到，属于**静默假完成**。建议停用或移除。
2. **密钥明文**：`C:\Users\22923\.omp\agent\mcp.json` 里明文存放 `TENCENTCLOUD_SECRET_ID/KEY` 与 `MINIMAX_API_KEY`（由 omp 侧模型在排查时读出并报告）。建议改环境变量引用。
