# dsh-hindsight-memory

**DSH ⇄ omp 记忆行为对齐插件（中间层）**

把「模型说的话」翻译成「omp 也会做的同一件事」：同一个 Hindsight 记忆库、同一套标签语义、同一套分层、同一套过滤规则。

---

## 它解决什么

| 现状 | 痛点 |
|------|------|
| DSH 用 dsh-mnemon 的 Hindsight provider | 写侧能打标签，**读侧不能按项目过滤**（`search()` 请求体里没有 `tags`）⇒ 读的是整库 |
| omp 用官方原生 Hindsight 后端 | 读侧按 `project:<label>` 过滤，读不到别的项目；但它**产不出无标签的全局层** |
| 两边各写各的 | 同一个记忆库里标签规则不统一 ⇒ 写着写着就互相看不见 |

本插件把 DSH 侧换成**受控的中间层**：模型只看见 4 个语义化工具，标签与记忆库路由由插件自动处理，模型碰不到 `tags`、碰不到 `bankId`。

```
模型 ──▶ memory_recall / memory_retain / memory_reflect / memory_status
              │  （插件盖章：project:<小写仓库名> 或 无标签）
              ▼
        Hindsight 记忆库 `shared`
              ▲
              │  （omp 原生后端：自动盖章 + 自动过滤）
            omp
```

## 四个工具

| 工具 | 作用 | 与 omp 的对应 |
|------|------|----------------|
| `memory_recall(query, scope?)` | 召回长期记忆。`scope=project`（默认）= 本项目 + 全局；`project_only` = 只本项目；`global` = 只全局 | omp 的 `recall` |
| `memory_retain(content, tier?)` | 写入耐久事实。`tier=project`（默认）只有本项目可见；`tier=global` 所有项目可见 | omp 的 `retain` |
| `memory_reflect(query, scope?)` | 让记忆服务综合回答（不是返回原始条目） | omp 的 `reflect` |
| `memory_status()` | 连通性、当前记忆库、项目标签、各层条数 | omp 无（诊断用） |

**标签是插件的事，不是模型的事**：模型不传 `tags`，插件按 `basename(主 checkout 根).toLowerCase()` 盖章——与 omp 的 `projectLabel()` 逐字同规则。

---

## 与 `dsh-mnemon` 的分工（重要）

两个插件**不冲突，但只有一层能连 Hindsight**。当前配置是：

| 层 | 归谁 | 连 Hindsight？ | 说明 |
|---|---|---|---|
| ① 运行时记忆 | `dsh-mnemon` | ❌ | 本地 `MEMORY.md` / `USER.md` 投影，常驻注入上下文，omp 看不到 |
| ② 项目档案 | `dsh-mnemon` | ❌ | 本地 markdown，按需检索，omp 看不到 |
| ③ **记忆空间** | **本插件接管** | ✅ | 与 omp 记忆系统**同层**：同一个记忆库、同一套标签、同一套过滤 |
| ④ 技能管理 | `dsh-mnemon` | ❌ | 技能账本，不是记忆层 |

> 🔴 **dsh-mnemon 的 Hindsight provider 必须保持「不启用」**（`enabled.hindsight=false`，配置保留可一键回滚）。
> 它的写侧能打标签，但**读侧不支持按项目过滤**（provider 0.5.6 的 `search()` 请求体写死 `{query,budget,max_tokens,types,prefer_observations}`），
> 开着它就会出现「两边都在写、但过滤规则不一致」的分裂。**记忆空间组件本身不要关**——关掉会让 dsh-mnemon 的检索提醒整片清空。

## `shared` 是什么？（常见误解澄清）

**`shared` 是记忆库（bank）的名字，不是前缀。**

- Hindsight 服务里存的是「记忆库（bank）」，每个库是一块独立空间。可以有多个库，服务端有 `/v1/default/banks` 接口可列。
- 当前这台机器上**只建了一个库 `shared`**——因为 omp 与 DSH 要共享同一块记忆空间。
- **项目隔离不靠库名，靠标签**：`shared` 库内部用 `project:<仓库名小写>` 标签区分项目层，用「无标签」表示全局层。
  所以**不会**出现「每个项目目录前面都加 shared」这种结构——所有项目的记忆都在同一个 `shared` 库里，靠标签分层。
- 如果把 omp 改成 `scoping: per-project`，Hindsight 侧就会真的多出 `shared-随便问问`、`shared-blog` 这样的**多个库**；那是另一种方案（硬隔离、无全局层），本插件默认对齐 omp 官方的 `per-project-tagged`。

一句话：**`shared` = 共享的那块记忆空间；`project:<名字>` = 这条记忆属于哪个项目。**

---

## 面板：三个层次，各管一段

| 面板 | 位置 | 能看/能改什么 |
|---|---|---|
| **插件管理（配置）** | DSH → 插件 → `dsh-hindsight-memory` → 配置 | 逐项查看并修改插件配置（服务地址、记忆库、作用域、预算、只读/读写、自动召回/留存…）。配置写错**不会炸 profile**——非法输入一律回落到默认值 |
| **终端状态面板** | `node scripts/panel.mjs` | 服务健康、记忆库清单、**分层条数**（全局层 / 本项目层 / 其它项目层）、最近事实与其标签；项目标签按 omp 同规则自动推导，也可用 `--project <名字>` 覆盖 |
| **官方前端（最详细）** | <http://127.0.0.1:9999> | Hindsight Control Plane：知识页、实体、关系图、原始事实、库管理 |

> 终端面板刻意**不经过模型**：跨 agent 记忆的验收只认服务端原始数据，模型自述不算证据。

---

## 安装

```bash
# 从 GitHub 装（推荐；仓库即源码）
dsh plugin --profile web add "git+https://github.com/meisijiya/dsh-hindsight-memory.git"

# 或本地开发（包名会被 DSH 用 import(name) 加载；Windows 不能用裸绝对路径）
dsh plugin --profile web add "file:D:/path/to/dsh-hindsight-memory"
```

> 需要**重启 DSH Web** 才会装载。回滚：`dsh plugin --profile web remove dsh-hindsight-memory`。

包声明了 `dsh.bundle.patch`，走 bundle 路线，profile 装载时自动组合插件自己的 `cordis.patch.yml`。

## 配置

```yaml
- insert:
    - id: hindsight-memory
      name: 'dsh-hindsight-memory'
      config:
        enabled: true          # 总开关
        inject: true           # 是否注入常驻系统提示词段
        writeEnabled: true     # false = 只读（灰度第一步）
        apiUrl: 'http://127.0.0.1:8888'
        bankId: shared          # 必须与 omp 的 hindsight.bankId 一致
        bankIdPrefix: ''
        scoping: per-project-tagged   # global | per-project | per-project-tagged
        types: [world, experience]     # 与 omp 的 recallTypes 同值
        budget: mid
        reflectBudget: low
        maxTokens: 1024
        recallMaxQueryChars: 800
        autoRecall: true        # 首回合自动召回（与 omp 的 autoRecall 默认值一致）
        autoRetain: true        # 回合结束自动留存（与 omp 的 autoRetain 默认值一致）
        retainEveryNTurns: 3
        sectionOrder: 950
```

**配置写错不会炸 profile**：所有非法输入一律回落到默认值（`normalizeConfig` 不抛错）。

> `autoRecall` / `autoRetain` 与 omp 的默认值对齐（都开）。想改成只读或纯手动，在插件配置面板里把
> `writeEnabled` 或 `autoRetain` 关掉即可，不需要改代码。

## 缓存稳定性（为什么提示词段是常量）

DSH 把**工具 schema 放进缓存前缀**：工具集合一变 ⇒ 请求头变 ⇒ 重开请求序列 ⇒ 缓存作废。所以：

1. 工具**只在装载时注册一次**，任何回合都不注册/注销。
2. 系统提示词段是**编译期常量**（无时间戳、无项目名、无记忆内容）；关闭时返回空串而不是换文本。
3. 变化的内容（召回结果）走**用户消息**，落在缓存边界之后。
4. 绝不改共享配置对象——请求配置在宿主侧是 `deepFreeze(structuredClone(...))`。

详见 `docs/design.md` §12。

## 开发

```bash
node --test "test/*.test.js"     # 18 个单测（Windows 上不能写 node --test test/，会被当成模块解析）
node scripts/verify-live.mjs    # 活体自检（需要 Hindsight 服务在跑，8 项检查）
node scripts/panel.mjs          # 状态面板（项目标签自动按 omp 同规则推导）
```

## 已知差异（与 omp 的诚实账）

- 召回注入载体是 DSH 的**用户消息**，omp 是 `<memories>` 背景块——形状已对齐，载体不同。
- 自动召回结果未持久化进 session 文件，resume 会重查一次（omp 会重放缓存块）。
- 自动留存是「本回合文本」简化版，未实现 omp 的 full-session 整段重发 + `document_id=sessionId`。
- DSH 侧**纯全局层读取**需要「整库读 + 客户端过滤」（服务端没有「只取无标签」的表达）。
- omp 自己**产不出全局层**（它的 retain 恒带 `project:` 标签）；全局层目前只由 DSH 侧不传标签写入。
