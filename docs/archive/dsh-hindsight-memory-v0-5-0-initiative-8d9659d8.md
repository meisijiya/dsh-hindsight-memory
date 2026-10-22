---
id: "8d9659d8-9abe-4c99-9fda-e58181e44aec"
title: "dsh-hindsight-memory v0.5.0 · 知识页与 initiative 层（落地与验收）"
description: "DSH⇄omp 统一记忆插件 dsh-hindsight-memory v0.5.0：把 Hindsight 服务端 /knowledge-base 的知识页与 initiative 能力封装成两个与 omp 同语义的工具，并给出活体验收证据、探针清理记录与服务端硬约束。"
status: "active"
created_at: "2026-10-22T11:58:29.398Z"
updated_at: "2026-10-22T11:58:29.398Z"
content_hash: "f3b080d0a01692876721cf23e233c7dda090fdcad1213fdc96d5d904134b41bc"
source_paths:
  - "dsh-hindsight-memory/src/pages.js"
  - "dsh-hindsight-memory/src/index.js"
  - "dsh-hindsight-memory/src/client.js"
  - "dsh-hindsight-memory/src/config.js"
  - "dsh-hindsight-memory/test/pages.test.js"
  - "dsh-hindsight-memory/docs/design.md"
  - "dsh-hindsight-memory/README.md"
  - "dsh-hindsight-memory/scripts/verify-live.mjs"
session_ids:
  - "session-43883589-ddc1-421b-b98b-e8eb4ba66b78"
memory_body_ids:
  []
---

# dsh-hindsight-memory v0.5.0 · 知识页与 initiative 层

## 背景

用户对比官方 `hindsight-integrations/coding-agents` 后问「知识页 / codebase survey / initiative 这三个干嘛的？」，
并批准（m04268「可以。」）先搬**知识页 + initiative**，**codebase survey 留作默认关闭的开关**。

## 三个能力的归属

| 能力 | 归属 | 本质 |
|---|---|---|
| 知识页 knowledge pages | 服务端 | `/knowledge-base` 树里的 page 节点；`source_query` 写「这页回答什么问题」，服务端按 trigger 合成正文；检索是服务端 BM25 + 向量 RRF |
| codebase survey | 客户端编排 | 官方用 claude/codex/opencode 外部 CLI 跑 `SURVEY_PROMPT`，把仓库结构固化成 4 篇文档，每 N 个 commit 重刷 |
| initiative | 服务端页 + 一条记忆标记 | 建文件夹 → 建页（tag `knowledge:feature-work`）→ retain 一条 `initiative-marker-<slug>` 事实，`context` 里 `[[page:<id>]]` 互链 |

## 为什么 survey 不搬

- 官方实现要调外部 CLI：花 token、本机也没装 claude/codex/opencode。
- 它把仓库结构固化成记忆，与 omp「只记人的决策」不同源。
- **官方写的文档不带本项目小写标签** ⇒ omp 的 `per-project-tagged` 召回看不见（只认「无标签」或「带本项目标签」），DSH 侧又是整库读 ⇒ 只会变成「谁也看不见的垃圾堆」。
- 本插件若要做对应能力，必须走「DSH subagent + 盖 `project:<小写名>` + 默认关闭」。

## 服务端硬事实（本机实测）

- `GET /v1/default/banks/{bank}/knowledge-base/tree` → 200 `{"roots":[]}`（新建的库树是空的）。
- `GET .../knowledge-base/search?q=&limit=` → 200 `{"results":[],"total":0}`。
- `GET .../knowledge-base/pages` → **405**（列表走 tree、搜索走 search、建页走 POST pages）。
- `POST /knowledge-base/pages` 请求体 required `['name','source_query']`，可选 `parent_id` / `tags` / `max_tokens` / `trigger`。
- **`max_tokens` 必须 ≥ 256**，否则 422 `{"type":"greater_than_equal","loc":["body","max_tokens"]}`。
- `POST /knowledge-base/folders` required `['name']`。
- 删除节点：`DELETE /knowledge-base/nodes/{node_id}` → 200 `{"status":"deleted"}`。
- **页正文是异步合成的**：刚建完立刻 search 只能拿到 `snippet="No content yet."`。

## 搬入时守的三条线（与 omp 对齐的具体含义）

1. **产出必须盖 `project:<小写 basename>` 标签** —— omp 召回白名单只认「无标签」或「带本项目标签」。
2. **不复用官方的 `source:` / `harness:` 标签** —— 那是官方包的 provenance 前缀，混进项目标签集会让 DSH 侧按白名单过滤时把自家内容挡掉（`sanitizeTags` 已在写入侧丢弃这两个前缀）。
3. **写操作 `async:true` + `metadata.session_id`** —— 与 omp 的 retain 体例一致。

## 实现落点（`D:\26code\随便问问\dsh-hindsight-memory\`）

- `src/pages.js`（纯函数，可单测）：`slugify` / `initiativeSourceQuery` / `pageTags` / `normalizeTags` / `buildPageRequest`（max_tokens 夹到 256）/ `flattenTree` / `filterPagesByScope`（无标签=全局层可见）/ `normalizeSearchResults` / `initiativeMarkerContent` / `initiativeMarkerContext` / `findInitiativeMarkers`。
- `src/client.js`：`listKnowledgeTree` / `searchKnowledgePages` / `readKnowledgePage` / `createKnowledgePage` / `ensureFolder`，**全部走 REST**（MCP 工具面已被服务端收窄到 7 个，不含知识页接口）。
- `src/index.js`：新增 `memory_pages`（list/search/read/create）、`memory_initiative`（capture/list）；注册时用 `config.knowledgePages` 过滤 —— **工具数量必须在 apply 时定**，因为工具 schema 在请求头缓存前缀内，中途增删会让没有 `toolUpdate` 能力的适配器重开请求序列、缓存作废。
- `src/config.js`：`knowledgePages`（默认 true）/ `pageSearchLimit`（5）/ `pageMaxTokens`（2000，下限 256）/ `initiativeFolder`（"Initiatives"）。
- `src/prompt.js`：工具说明加两行；`src/ui-client.js`：配置面板加「知识页」组 4 项。
- `test/pages.test.js`：13 条单测。

## 活体验收（旁路 `dsh headless --patch`，不动用户实例）

五连调用全部 `ok:true`：

| 调用 | 返回 |
|---|---|
| `memory_pages list` | folders=[]、pages=[]、totalPages=0 |
| `memory_pages create` | pageId=`kp-77c6aeb8…`、operationId=`41e2e487…` |
| `memory_pages search` | count=1、snippet="No content yet."（正文未合成完） |
| `memory_initiative capture` | 自动建文件夹 `kf-109a5fb9…`、页 `kp-c2aa8496…`、marker `{ok:true}` |
| `memory_initiative list` | count=1、isStale=false、**markers=[]** |

## 探针清理（已做，账目清晰）

- 2 个探针页 + 1 个 `Initiatives` 文件夹：`DELETE /knowledge-base/nodes/{id}` → 均 200 `{"status":"deleted"}`。
- 1 条标记事实 `c58a15f7-38f1-4906-a02d-35d28b9620f6`：`PATCH {"state":"invalidated"}` → 200。
- 复查：`GET /knowledge-base/tree` roots=0；库内无残留探针事实。
- 库规模：清理后 bank `shared` fact_count 235（清理前 235，探针页不计入 fact 数）。

## 两条实测教训（免得下次再踩）

1. **标记事实是异步的**：`capture` 返回 `marker:{ok:true}` 只代表入队成功，事实真正落库要 1~2 分钟；紧接着 `list` 看到 `markers:[]` 是正常时序，**不是失败**。排查要用 `GET /memories/list?limit=1000` 再按 `context` 过滤 —— `limit=200` 会漏（当时库里有 235 条事实）。
2. **项目标签取自工作目录**：验收时 headless 跑在 `C:\Users\22923`（非 git 仓库），标签退化成 `project:22923` —— 这是 `label.js` 的**正确降级**（basename(cwd).toLowerCase()），但意味着**在非项目目录里跑插件会污染项目层标签**，验证必须在真实项目目录里跑。

## 顺带修的一个自检假阴性

`scripts/verify-live.mjs` 原来固定等 25s 再查探针事实，服务端繁忙时抽取超过 25s ⇒ 报「REST 与 MCP 召回到同一批探针事实 FAIL / 探针事实已作废 FAIL」（6/8）。
改为**轮询**（每 10s 查一次，最多 180s，可用 `HS_VERIFY_WAIT_MS` 覆盖）后稳定 8/8（探针约 30s 落库）。

## 发布与安装

- 提交：`97675d0`（代码 v0.5.0）→ `5c3f8ba`（index.json 发布 0.5.0 条目，commit 钉 40 位 sha）→ `deec8cb`（自检轮询修复）；均已 push 到 https://github.com/meisijiya/dsh-hindsight-memory。
- 索引：`node scripts/validate-market-index.mjs` → 20 pass / 0 fail；`node --test "test/*.test.js"` → 70/70。
- profile 升级：`cd C:\Users\22923\.dsh\profiles\web && pnpm update dsh-hindsight-memory --latest` → 装到 0.5.0；安装态冒烟：注册 **9 个工具**（memory_recall/retain/reflect/status/hygiene/mental_models/operations/pages/initiative）、Config 38 键、`knowledgePages` 仍为 volatile。
- 生效方式：profile 层 patch 在**启动时**解析 ⇒ 需重启 DSH Web 才装载 0.5.0（重启会中断当前会话，由用户决定时机）。
