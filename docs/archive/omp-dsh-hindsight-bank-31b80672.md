---
id: "31b80672-40e9-43f6-99b5-5881819fd12b"
title: "omp 与 DSH 共享 Hindsight 记忆层（单 bank + 双层标签）落地手册"
description: "本机 omp(oh-my-pi) 与 DeepSeek Harness 共用一个 Hindsight bank 的长期记忆方案：单 bank `shared` + 无标签=全局层 / project:<名> 标签=项目层；DSH 侧走官方 per-bank MCP 通道（dsh-mnemon 的 Hindsight provider 已停用）；含 DSH 四层记忆模型、标签真值表、调用约定、验收证据、踩坑与运维。"
status: "active"
created_at: "2026-10-21T12:36:16.754Z"
updated_at: "2026-10-22T02:54:19.107Z"
content_hash: "35c5d188525d8d411c3d7a372b8d2872b302761a86473db83f3a272e890b6b81"
source_paths:
  []
session_ids:
  - "session-43883589-ddc1-421b-b98b-e8eb4ba66b78"
memory_body_ids:
  []
---

# omp 与 DSH 共享 Hindsight 记忆层（单 bank + 双层标签）

> 2026-10-21 改版：取代早期「bank 级项目隔离」方案（每项目一个 bank `shared-<项目名>`），旧方案已废弃并删除。
> 2026-10-22 终版：DSH 侧改用 **Hindsight 官方 per-bank MCP** 取得读侧项目隔离；**dsh-mnemon 的 Hindsight provider 已停用**（配置保留、可一键回滚），MCP 是 DSH 侧唯一的 Hindsight 读写通道。

## 结论先说

- omp 与 DSH 的长期记忆**共用一个 Hindsight 服务**（本机 Docker `hindsight` 容器，API `127.0.0.1:8888`，控制面 UI `127.0.0.1:9999`）**和一个 bank `shared`**。
- 隔离层在**标签**，不在 bank：
  - **无 tag** = **全局层**，所有项目可见。
  - **带 `project:<仓库名>` 标签** = **项目层**，只在该项目里可见。
- omp 侧读写都按项目过滤（`scoping: per-project-tagged`，官方默认行为），标签自动盖章。
- DSH 侧读隔离靠 **Hindsight 官方 MCP 端点** `http://127.0.0.1:8888/mcp/shared/` + DSH 官方 `@deepseek-ai/dsh-mcp-client`（`transport: streamable-http`），工具为 `mcp__hindsight__retain / recall / reflect`，读写都能显式传 `tags`。
- dsh-mnemon 自带的 Hindsight provider（0.5.6，npm 最新）**读侧不支持 tag 过滤**（`search()` 请求体写死 `{query,budget,max_tokens,types,prefer_observations}`，无 `tags`），所以它**已停用**；否则 DSH 侧会读出其它项目的项目层记忆。

## 为什么必须单 bank

omp 的 Hindsight 后端一次只连**一个** bank（`hindsight.bankId` + `bankIdPrefix`），没有多 bank 读取能力。所以「跨项目共享的全局层」和「项目内隔离」只能共存于同一个 bank 内，靠标签分层——官方 `per-project-tagged` 正是这个设计。

## DSH 侧的四层记忆（插件面板 ≠ 统一方案里的分层）

| 层 | 组件 | 形态 | 触发方式 | 作用范围 | 与 Hindsight 有关？ |
|---|---|---|---|---|---|
| ① 运行时记忆 | `dsh-mnemon-source-runtime` | 本地 `MEMORY.md` / `USER.md` 投影（真源 `memories.json`） | **常驻**，每轮随上下文注入 | 当前会话 + 本机全局 | ❌ 纯本地，omp 看不到 |
| ② 项目档案 | `dsh-mnemon-source-documents` | 本地 markdown 知识文档 | **按需检索**（`mnemon_document_search`） | 当前工作区 | ❌ 纯本地，omp 看不到 |
| ③ 记忆空间 | `dsh-mnemon-source-memory-spaces` | 第三方 Provider 承载的长期记忆 | **完全按需**：写要显式调用，读要显式召回 | 可跨 agent / 跨项目（按 bank+tag） | ✅ 唯一连 Hindsight 的层（provider 已停用，改走 MCP） |
| ④ 技能管理 | `dsh-mnemon-source-skills` | 技能账本 | 不是记忆层 | — | ❌ |

另外两套常被混称的「分层」：
- **统一方案的标签分层**（无 tag = 全局层 / `project:<名>` = 项目层）——纯 Hindsight 概念，omp 与 DSH 共用。
- **存储面板的「存储范围」**（全局 / 工作区 / 集中 / 指定目录）——只决定 `~/.mnemon` 这套本地目录的布局，不改服务端 bank。

## 组件与配置

### 服务端

```bash
docker run -d --name hindsight --restart unless-stopped -p 8888:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_PROVIDER=openai \
  -e HINDSIGHT_API_LLM_BASE_URL=http://host.docker.internal:3425/v1 \
  -e HINDSIGHT_API_LLM_MODEL=minimax-code/MiniMax-M3.1-Flash \
  -e HINDSIGHT_API_LLM_API_KEY=EMPTY \
  -e HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai \
  -e HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL=http://host.docker.internal:11434/v1 \
  -e HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=ollama \
  -e HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL=qwen3-embedding:0.6b \
  -e HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS=1024 \
  -e HINDSIGHT_API_RERANKER_PROVIDER=rrf \
  -v hindsight-data:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest
```

- LLM 走本机 Magpie 网关（3425）上的 `minimax-code/MiniMax-M3.1-Flash`；embeddings 走本机 Ollama `qwen3-embedding:0.6b`（1024 维）；reranker 用 `rrf`（直通不重排）。
- 容器经 `host.docker.internal` 可访问宿主 Ollama/Magpie，**不需要**改 Ollama 的 `OLLAMA_HOST`（容器内 `172.17.0.1:11434` 不通，`host.docker.internal:11434` 通）。
- 镜像内不含 embedding/reranker 模型，`local` reranker 会去下 HF 模型；`reranker=none` 会让容器崩溃循环（config.py:4156 的提示不可信），要用就用 `rrf`。
- **Docker Desktop 的 AutoStart=false**（`%APPDATA%\Docker\settings-store.json`）：开机后引擎不自启 → 8888 无人监听 → omp 的 recall/retain **静默失败**，表现为「记忆突然失忆」。排查第一步永远先 `docker ps` + `curl 127.0.0.1:8888/health`；`restart=unless-stopped` 替代不了引擎自启。

### MCP 工具面收窄（服务端按 bank 收）

```bash
PATCH http://127.0.0.1:8888/v1/default/banks/shared/config
{"updates":{"mcp_enabled_tools":["retain","recall","reflect","list_memories","get_memory","list_banks","get_bank","get_bank_stats","list_tags"]}}
```

收窄后 `tools/list` 从 36 个降到 7 个（`retain/recall/reflect/list_memories/get_memory/list_tags/get_bank`），去掉了 `delete_bank` / `clear_memories` / `invalidate_memory` 等破坏性工具。DSH 的 mcp-client **没有工具白名单**，会照单全收服务端列出的工具，所以收窄必须做在服务端。源码：`config.py:4823`（`mcp_enabled_tools`）、`mcp_tools.py:789`（`_apply_bank_tool_filtering`）。

### omp 侧（官方原生后端，不装 MCP 插件、不自写技能）

`C:\Users\22923\.omp\agent\config.yml`：

```yaml
memory:
  backend: hindsight
hindsight:
  apiUrl: http://127.0.0.1:8888
  bankId: shared
  scoping: per-project-tagged
  bankMission: "..."
  retainMission: "..."
```

- 官方文档：`docs/memory.md` 的「Hindsight remote backend」；18 个 `HINDSIGHT_*` 环境变量见 `docs/environment-variables.md`。
- 模型侧指令由 omp 自带 `packages/coding-agent/src/prompts/system/hindsight-instructions.md` 注入，`recall`/`retain`/`reflect` 工具由后端暴露，**不需要外挂 skill、不需要 MCP 插件**。
- 项目标签由 `bank.ts` 的 `projectLabel()` 自动生成：git 主 checkout 根目录 basename **转小写**（本仓库 → `随便问问`）。
- 备份：`config.yml.hindsight-bak-20261021`、`config.yml.perproject-bak-20261021-201615`、`config.yml.tagged-bak-20261021-220229`。

### DSH 侧（官方 MCP 通道）

`C:\Users\22923\.dsh\profiles\web\cordis.patch.yml` 末尾（备份 `cordis.patch.yml.bak-mcp-20261022-0040`）：

```yaml
- insert:
    - id: mcp-hindsight
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: hindsight
        transport: streamable-http
        url: 'http://127.0.0.1:8888/mcp/shared/'
        failOnStartupError: false
        toolCallTimeoutMs: 120000
```

- 工具名规则 `mcp__<serverName>__<rawName>` ⇒ `mcp__hindsight__retain / recall / reflect / list_memories / get_memory / list_tags / get_bank`。
- 改 `cordis.patch.yml` 必须**重启 DSH Web** 才生效（profile 层 patch 在启动时解析）。
- dsh-mnemon 的 Hindsight provider 已停用（`C:\Users\22923\.mnemon\state\memory-providers.json` → `enabled.hindsight=false`），配置保留，回滚只需把它改回 `true` 并重启。
- 停用 provider 后，dsh-mnemon 侧 `mnemon_recall` / `mnemon_remember` 工具会消失、记忆空间面板显示「还没有记忆空间 / 0/0 已激活」，这是**预期结果**（`mnemon_status` 的 notice 会提示没有 Provider 就没法建记忆空间）。若要保留 dsh-mnemon 的分层策略提示，**不要关记忆空间组件**，只关 provider。

## 调用约定（DSH 侧）

| 意图 | 工具 | 参数 |
|---|---|---|
| 召回本项目 + 全局层 | `mcp__hindsight__recall` | `tags=["project:<仓库名小写>"]`、`tags_match="any"`、`budget="low|mid|high"` |
| 召回全部（跨项目调试） | 同上 | 不传 `tags` ⇒ 整库可见 |
| 写项目层 | `mcp__hindsight__retain` | `tags=["project:<仓库名小写>"]` |
| 写全局层 | 同上 | **不传 tags**（`tags=[]`） |
| 综合问答 | `mcp__hindsight__reflect` | `query` + `budget`（不带 tags ⇒ 整库） |

- 项目名 = **git 主 checkout 根目录 basename 转小写**（必须与 omp 一致，英文含大写的仓库名两边会对不上）。
- 写入是**异步抽取**：retain 只返回 `{"status":"accepted","operation_id":...}`，事实通常 20–40 秒后落库；`budget="low"` 的召回不一定把它排进 top，查证用 `mcp__hindsight__list_memories`。
- DSH 侧必须**显式传标签**（omp 是自动盖章），这是两端唯一的写侧差异。

## 标签真值表（服务端实测，bank `probe-tiers`）

请求 `tags=["project:zzztest"]`、`tags_match="any"`：

| 事实的 tags | 可见？ |
|---|---|
| 无 tag | ✅（全局层，对所有项目可见） |
| `project:zzztest` | ✅ |
| `project:zzztest` + `source:chat` | ✅ |
| `scopetest`（无关标签） | ❌ |
| `source:chat` + `harness:dsh`（无 project 标签） | ❌ |

- 精确语义：**可见 ⟺ 完全没有标签，或至少命中一个请求标签**（白名单，不是"任意标签命中"）。
- `tags_match="any_strict"` 只返回严格带标签项。
- 不传 `tags` ⇒ 整库全可见。
- 推论：多带 `source:` / `harness:` 无妨，只要同时带正确的 `project:<label>`。

## 验收证据（2026-10-22 实测）

| 项 | 结果 |
|---|---|
| 重启后工具面 | `mnemon_recall`/`mnemon_remember` 消失；`mcp__hindsight__*` 7 个工具就位 ⇒ MCP 行生效、provider 停用生效 |
| 项目层召回 | `recall tags=["project:随便问问"] any` → 39 条，项目层(`project:随便问问`)与全局层(`[]`)混排 |
| 隔离 | 同 query `tags=["project:另一个不存在的仓库"]` → 15 条且**全部** `tags=[]`，无一条 `project:随便问问` |
| 全局层可见性 | 新写的无 tag 事实（DSH 四层模型）在**任意**项目标签下都能召回 |
| 写路径 | `retain` 不传 tags → 落库 `tags=[]`；`retain` 带 `project:随便问问` → 落库 `["project:随便问问"]` |
| 过期事实清理 | 6 条「DSH 用 dsh-mnemon provider 记忆空间」旧事实已 PATCH `state=invalidated`（5×200；1 条 observation 404，随父 world 一并消失） |

## 已知不对称（说清楚，别装看不见）

1. **写侧**：omp 自动盖 `project:<label>`；DSH 侧要手动传标签，漏传就写进全局层。
2. **读侧**：omp 首轮自动召回（`autoRecall`）+ 每 3 回合自动 retain；DSH 侧**全靠模型显式调用** MCP 工具，没有自动注入。
3. **全局层生产者**：omp 的 `per-project-tagged` 永远带 project 标签，**写不出无 tag 全局层**；全局层只能由 DSH 侧不传 tags 的 retain 产生。
4. **mental model / reflect**：DSH 侧 reflect 不带 tags，等于整库检索。

## 常见坑

1. **标签大小写**：omp 转小写，DSH 手动传必须跟着转小写，否则两边互不可见。
2. **中文 bank id 要 percent-encode**：`shared-%E4%BE%B0%E9%97%B2%E9%97%AE%E9%97%AE`；直接塞 raw UTF-8 路径会造出乱码 bank（`shared-侰闲问问`）。
3. **bash 内联 curl 传中文 JSON body 会 400**（`There was an error parsing the body`）：body 写文件后 `--data-binary @file`。
4. **同名 bank**：查询前先 `GET /v1/default/banks` 确认 `fact_count`，否则「recall 返回 0」是假象。
5. **omp config.yml 是 YAML 陷阱**：值里出现未加引号的 `": "`（如 `Extract durable, reusable facts: ...`）会让 omp 报 `SyntaxError: YAML Parse error`，并把 config.yml 改名隔离成 `config.yml.broken-<ts>-<pid>-<uuid>` 后退回默认值（`memory.backend=off`）。恢复靠备份 cp 回去；修改用双引号包裹 mission 字符串。
6. **`filter` 参数被服务端静默忽略**；fact type 只允许 `world` / `observation` / `experience`。
7. **MCP 需要会话**：`initialize` 返回头 `mcp-session-id`，后续请求要带；不带会 404 `Session not found`。
8. **mental model 长期 stale**：容器未设 `HINDSIGHT_API_REFLECT_WALL_TIMEOUT` ⇒ `refresh_mental_model` 用默认 300 秒上限，LLM 网关慢就超时，mental model 被标 `is_stale=true`、注入内容滞后。

## 运维 / 新增项目

- 新项目**无需改配置**：omp 自动按 `basename.toLowerCase()` 生成标签；DSH 侧只要按同一规则传 `project:<名>` 即可。
- 容器挂了先看 `docker ps` 与 `curl 127.0.0.1:8888/health`；Docker Desktop 需要手动启动（AutoStart=false）。
- 停用/启用 dsh-mnemon 的 Hindsight provider：插件 → 可组合记忆 → 记忆空间 → Provider 面板的开关；改完重启 DSH。
- 需要 MCP 工具面变更：改服务端 `mcp_enabled_tools`（`PATCH /v1/default/banks/{bank}/config`），无需改 DSH。
- 手工清理过期事实：`PATCH /v1/default/banks/shared/memories/{id}` body `{"state":"invalidated"}`（observation 类型不可直接 PATCH，会随父 world 失效）。

## 版本沿革

| 时间 | 方案 | 结果 |
|---|---|---|
| 2026-10-21 上午 | per-project bank（`shared-<项目名>`）硬隔离 | 隔离成立但没有全局层，放弃 |
| 2026-10-21 晚 | 单 bank `shared` + 双层标签（omp `per-project-tagged`） | 全局层 + 项目层成立；DSH 读侧无过滤 |
| 2026-10-22 | DSH 改走 Hindsight 官方 per-bank MCP + 服务端收窄工具面，dsh-mnemon provider 停用 | 读侧项目隔离成立，DSH 与 omp 语义对齐 |
