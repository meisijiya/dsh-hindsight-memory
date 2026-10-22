---
id: "94e066ee-dbef-41da-9556-c1b9c08c3304"
title: "dsh-hindsight-memory · 安装、面板、运维与排障 r3"
description: "dsh-hindsight-memory 插件落地状态 r3：已装进 DSH web profile（github:meisijiya/dsh-hindsight-memory），远程仓库 https://github.com/meisijiya/dsh-hindsight-memory，配置面板改为插件自带的浏览器 client 半体（src/ui-client.js，注册 plugins.row.config + plugins.bundle.config 槽位），并查明「配置按钮不出现」的根因＝DSH 进程级 pkgMeta 缓存 ⇒ 必须重启 DSH Web；另含 shared 释义、与 dsh-mnemon 职责边界、bundle 开关机制、运维命令与 8 条踩坑表。\""
status: "active"
created_at: "2026-10-22T04:49:46.875Z"
updated_at: "2026-10-22T05:38:42.320Z"
content_hash: "09c5a9f756cbffff14bf151df4d90f2611dd96d43b751a009b21898c4594139f"
source_paths:
  - "dsh-hindsight-memory/src"
  - "dsh-hindsight-memory/scripts"
  - "dsh-hindsight-memory/docs/design.md"
  - "dsh-hindsight-memory/README.md"
  - "dsh-hindsight-memory/cordis.patch.yml"
session_ids:
  - "session-43883589-ddc1-421b-b98b-e8eb4ba66b78"
memory_body_ids:
  []
---

---
id: "94e066ee-dbef-41da-9556-c1b9c08c3304"
title: "dsh-hindsight-memory · 安装、面板、运维与排障 r3"
description: "dsh-hindsight-memory 插件落地状态 r3：已装进 DSH web profile（github:meisijiya/dsh-hindsight-memory），远程仓库 https://github.com/meisijiya/dsh-hindsight-memory，配置面板改为插件自带的浏览器 client 半体（src/ui-client.js，注册 plugins.row.config + plugins.bundle.config 槽位），并查明「配置按钮不出现」的根因＝DSH 进程级 pkgMeta 缓存 ⇒ 必须重启 DSH Web；另含 shared 释义、与 dsh-mnemon 职责边界、bundle 开关机制、运维命令与 8 条踩坑表。"
status: "active"
created_at: "2026-10-22T04:49:46.875Z"
updated_at: "2026-10-22T13:40:00.000Z"
source_paths:
  - "dsh-hindsight-memory/src"
  - "dsh-hindsight-memory/scripts"
  - "dsh-hindsight-memory/docs/design.md"
  - "dsh-hindsight-memory/README.md"
  - "dsh-hindsight-memory/cordis.patch.yml"
session_ids:
  - "session-43883589-ddc1-421b-b98b-e8eb4ba66b78"
memory_body_ids:
  []
---

# dsh-hindsight-memory · 安装、面板、运维与排障（r3）

> 2026-10-22。配套 r1《DSH ⇄ omp 统一记忆插件 · 设计与验收 r1》（文档 id `fc80fc27-c0d3-4d42-baeb-858401a3c5c1`）。
> 本篇讲**落地之后的事**：装在哪、仓库在哪、面板怎么看、为什么面板不出现、日常怎么运维、`shared` 到底是什么。

## 1. 当前状态（已装、已验证）

| 项 | 值 | 证据 |
|---|---|---|
| 远程仓库 | `https://github.com/meisijiya/dsh-hindsight-memory` | 提交链 17c25f1 → b257602 → 1326d64 → b293f4d → 673cdd3 → a938a39 → 04bf465，均已推送；`index.json` 为插件市场索引（format-1），v0.1.0 钉住 commit `17c25f1` |
| 源码位置 | `D:\26code\随便问问\dsh-hindsight-memory\`（独立 git 仓库，与父仓库各自独立） | `git log` / `git remote -v` |
| profile 依赖 | `dsh-hindsight-memory: github:meisijiya/dsh-hindsight-memory` | `C:\Users\22923\.dsh\profiles\web\package.json` |
| 是否在 bundles | 是（profile bundles 共 40 个；**误关过，已加回**） | 同上 `dsh.profile.bundles` |
| 组合结果 | `dsh --profile web --dump-config` 第 2604 行起可见 `id: hindsight-memory` 行 | 实跑输出 |
| 插件运行态 | 插件管理页卡片 `data-plugin-status=running` | ego-browser 实查 |
| 配置面板 | **待重启 DSH Web 后可见**（client 半体已装好，进程级缓存未刷新） | 见 §8 |
| 回滚 | `dsh plugin --profile web remove dsh-hindsight-memory` | — |

## 2. 安装 / 升级命令

```bash
# 安装（从 GitHub；包声明 dsh.bundle.patch，装上即自动组合插件自己的 cordis.patch.yml）
dsh plugin --profile web add "git+https://github.com/meisijiya/dsh-hindsight-memory.git"

# 升级（git 依赖要显式 update 才会重新解析分支 HEAD）
cd /c/Users/22923/.dsh/profiles/web && pnpm update dsh-hindsight-memory --latest

# 本地开发联调（Windows 不能用裸绝对路径，要 percent-encode 的 file:// URL）
dsh plugin --profile web add "file:D:/path/to/dsh-hindsight-memory"
```

## 3. 三个面板，各管一段

| 面板 | 位置 | 能看/能改什么 |
|---|---|---|
| 插件配置表单 | DSH → 插件 → `dsh-hindsight-memory` → 详情页 →「配置」 | 逐项查看/修改：服务地址、记忆库、作用域、预算、读写开关、auto*、注入段顺序。**配置写错不炸 profile**（非法输入一律回落默认值）。表单由插件自带的 client 半体渲染（`src/ui-client.js`），不是宿主自动生成 |
| 终端状态面板 | `node scripts/panel.mjs`（可加 `--dir <工作区>`、`--project <标签>`、`--api`、`--bank`） | 服务健康、bank 清单、**分层条数**（全局层 / 本项目层 / 其它项目层）、最近事实与其标签。直接读服务端原始数据，**不经过模型** |
| 官方 Control Plane | <http://127.0.0.1:9999> | Hindsight 官方前端：知识页、实体、关系图、原始事实、库管理（最详细） |

面板实测输出（工作区 `D:\26code\随便问问`）：

```
服务健康   healthy / db connected
记忆库      shared（服务上共 1 个：shared）
项目标签    project:随便问问
全局层(无 tag) 29 条 | 项目层 24 条 | 其它项目层 0 条 | 合计 53 条
```

## 4. `shared` 是什么（用户高频误解，务必讲清）

- **`shared` 是记忆库（bank）的名字，不是前缀。** Hindsight 服务里存的是「记忆库」，每库是一块独立空间，可用 `GET /v1/default/banks` 列出。本机**只建了一个库 `shared`**，因为 omp 与 DSH 要共享同一块记忆空间。
- **项目隔离不靠库名，靠标签**：`shared` 库内部用 `project:<仓库名小写>` 标签区分项目层，「无标签」表示全局层。**不会**出现「每个项目目录前面都加 shared」这种结构。
- 只有把 omp 改成 `scoping: per-project` 时，服务端才会真的多出 `shared-随便问问`、`shared-blog` 这样的多个库（硬隔离、无全局层）——那是另一种方案，本插件默认对齐 omp 官方的 `per-project-tagged`。
- 一句话：**`shared` = 共享的那块记忆空间；`project:<名字>` = 这条记忆属于哪个项目。**

## 5. 与 `dsh-mnemon` 的职责边界（终态）

| 层 | 归谁 | 连 Hindsight？ |
|---|---|---|
| ① 运行时记忆（本地 MEMORY.md/USER.md 投影，常驻注入） | dsh-mnemon | ❌ omp 看不到 |
| ② 项目档案（本地 markdown，按需检索） | dsh-mnemon | ❌ omp 看不到 |
| ③ **记忆空间**（长期记忆） | **dsh-hindsight-memory 接管** | ✅ 与 omp 记忆系统同层 |
| ④ 技能管理（技能账本） | dsh-mnemon | ❌ |

- dsh-mnemon 的 Hindsight provider 必须保持 **不启用**（`enabled.hindsight=false`，配置保留可回滚）：它写侧能打标签，但**读侧不支持按项目过滤**（provider 0.5.6 `search()` 请求体写死 `{query,budget,max_tokens,types,prefer_observations}`）。
- **记忆空间组件本身不要关**：关掉会让 dsh-mnemon 的 classicSources 判定失败，路由与文档检索提醒整片清空。

## 6. 本轮修掉的真问题（别再踩）

1. **面板「其它项目层」静默少算**：`foreignFacts` 过滤多了一个 `&& !PROJECT_TAG`，导致指定项目时恒为 0。已修为 `tags.length>0 && !(PROJECT_TAG && tags.includes(PROJECT_TAG))`。
2. **Windows 上 `node --test test/` 会报 MODULE_NOT_FOUND**（把目录当模块解析）。改成 `node --test "test/*.test.js"`。
3. **插件被误关**：插件管理页的开关 = 增删 profile `package.json` 里 `dsh.profile.bundles` 数组中的包名（服务端 `setBundleEnabled → selectBundle`）。误关后把包名加回数组即可恢复，**依赖不需要重装**；插件行级开关走 `setPluginEnabled → writePluginEnabled`。
4. **client 半体未注册 locale namespace**：`locale: "hindsightMemory"` 会让宿主为本 namespace 解析翻译函数，未注册过可能渲染报错 ⇒ 已删除 `locale` 字段，组件内文案直接写中文。
5. 判据教训：**schemastery v3 的 schema 自己也带 `~standard`**，所以「有没有 `~standard`」不能用来判断是否降级；要看 schema 自身有没有 `type/meta/dict` 这类 schemastery 字段。

## 7. 运维

```bash
# 状态面板 / 活体自检（8 项：MCP 握手、分层可见性、跨项目隔离负例、REST/MCP 同批、探针自动作废）
node scripts/panel.mjs --dir "D:/26code/随便问问"
node scripts/verify-live.mjs

# 单测（18 个）
node --test "test/*.test.js"
```

- Docker Desktop 必须常驻（AutoStart=false ⇒ 开机不启 ⇒ Hindsight 静默失忆，表现为「召回为空」）。
- 服务端 MCP 工具已按 bank 收窄到 7 个（retain/recall/reflect/list_memories/get_memory/list_tags/get_bank），破坏性工具（delete_bank/clear_memories/invalidate_memory…）已从 MCP 面移除。
- 结论口径：**隔离只认服务端原始数据，模型自述不算证据**（曾出现模型自称看到别的项目条目，被 API 探针 + `HINDSIGHT_DEBUG=1` 复跑证伪）。

## 8. 「配置按钮不出现」的根因与修法（2026-10-22 排障核心）

**现象**：插件运行中、工具可用、详情页能打开，但没有「配置」按钮；`GET /plugins/dsh-hindsight-memory/client.js` = 404。

**根因链（全部来自 DSH 源码）**：

1. 插件配置表单**不会自动渲染**。宿主只在某个 **client 半体**注册渲染槽位时才给入口：
   - `plugins.row.config`，键 = `<包名>#<行 id>`（行 id 取 bundle patch 里写的 `id`）；
   - `plugins.bundle.config`，键 = `<包名>`（渲染在详情页描述与行之间，仅 `view:'page'`）。
   契约：`dsh-cordis-client-runner/lib/client.js` slot catalog；渲染点 `dsh-client-ui-plugin-manager/lib/client.js:2818`。
   owner props：`{ view:'summary'|'page', form?:{ state:{status,value,base,user,revision,writable}, mutate(ops,expectedRevision) } }`，
   写操作 `{op:'set',path:string[],value}` / `{op:'unset',path:string[]}`。
2. client 半体由 `package.json` 的 `dsh.client={platform:'web',inject:[包名…]}` + `exports["./client"]` 决定；服务端 `dsh-client-modules/lib/index.js:722 resolveMeta()` 解析结果写入**进程级缓存 `pkgMeta`**，且**无失效入口**（全文件仅 3 处 set / 1 处 get）。
3. 缓存为 `null` 的包不进入 `sources`，`reconcilePackage()` 无从重建 ⇒ `/plugins/<包名>/client.js` 永远 404 ⇒ 浏览器不加载 ⇒ 无槽位占用者 ⇒ 无「配置」按钮。
4. ⇒ **磁盘上装好带 client 半体的新版本后，运行中的 DSH 不会重新解析**：重启 DSH Web 是唯一可靠路径，反复点插件开关无效（缓存照样命中）。

**已做的动作**：

- 新增 `src/ui-client.js`（浏览器经典脚本：`window.__ModuleLoader__.load({id, factory})`，factory 内 `require("react")`；宿主 seed 词表含 react / react-dom / zod / `@deepseek-ai/cordis` / client-store / client-ui-slots，可直接 require）。
- 同时注册 `plugins.row.config`（键 `dsh-hindsight-memory#hindsight-memory`）与 `plugins.bundle.config`（键 `dsh-hindsight-memory`），共用同一 React 表单组件（按 `src/config.js` 的 DEFAULTS/FIELD_DOCS 渲染字段，读 `props.form.state.value`、写 `form.mutate([{op:'set',path:[key],value}], revision)`）。
- `exports.inject = ["slots"]`（**服务名**列表，对齐 dsh-mnemon 的 `["slots","sessions",…]`）；`package.json` 的 `dsh.client.inject` 是**包名**列表。
- 提交 `a938a39`（去 locale + 加包级槽位）、`04bf465`（文档与排障表）；profile 已 `pnpm update --latest` 到该版本。

**DSH Web 401 自签 cookie 配方（排障用）**：cookie 名 = `dsh-auth-` + base64url(sha256(authority))，authority = `127.0.0.1:3080`；值 = `v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, body))>`，secret 取 `~/.dsh/.credentials.yaml` 的 `records.client-connection/browser-session.payload.secret`。⚠️ HMAC 必须覆盖 **base64url 后的 body 字符串**，不是原始 JSON。

## 9. 待办（只需一步）

**重启一次 DSH Web** ⇒ client 半体装载 ⇒ 「插件 → dsh-hindsight-memory → 详情页 → 配置」出现可编辑表单；随后把面板截图与字段写入验收结论。
