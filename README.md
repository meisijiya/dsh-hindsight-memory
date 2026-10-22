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

## 九个工具

| 工具 | 作用 | 与 omp 的对应 |
|------|------|----------------|
| `memory_recall(query, scope?)` | 召回长期记忆。`scope=project`（默认）= 本项目 + 全局；`project_only` = 只本项目；`global` = 只全局 | omp 的 `recall` |
| `memory_retain(content, tier?)` | 写入耐久事实。`tier=project`（默认）只有本项目可见；`tier=global` 所有项目可见 | omp 的 `retain` |
| `memory_reflect(query, scope?)` | 让记忆服务综合回答（不是返回原始条目） | omp 的 `reflect` |
| `memory_status()` | 连通性、当前记忆库（含 bank 体检告警）、项目标签、各层条数与类型分布、任务队列健康度 | omp 无（诊断用） |
| `memory_hygiene(action?, scope?)` | 整理**共享记忆库**：预览/清理近重复事实、触发 observation 合并、查看分层与口径命中；`scope` 可锁定某一层 | omp 无（见「记忆卫生」一节） |
| `memory_mental_models(action?)` | 维护**精神模型**（跨会话的经验总结）：`ensure` 幂等建好三个模型（用户偏好 + 本项目约定/决策），`list`/`content`/`refresh`/`patch` | omp 启动时自动建同样的三个（见「精神模型」一节） |
| `memory_operations(action?)` | 运维观测：列出抽取/刷新/合并任务，可 `retry` 失败任务 | omp 无（但 omp 也看不见失败任务） |
| `memory_pages(action?, id?, query?, title?, sourceQuery?)` | **知识页**层（服务端合成的长文）：`list` 读知识库树、`search` 检索、`read` 读整页、`create` 建页（自动盖本项目标签） | omp 无（服务端同一套能力） |
| `memory_initiative(action?, title?, question?)` | 把**正在做的事**登记成受跟踪的一页 + 一条标记事实（页与事实互链）：`capture` 登记、`list` 查看 | omp 无（服务端同一套能力） |

> 知识页与 initiative 是 **Hindsight 服务端原生能力**（`/knowledge-base`），本插件只是把它包成与 omp 同语义的工具：产出盖 `project:<小写项目名>` 标签、不复用官方的 `source:`/`harness:` 标签、写入走 `async:true` + `metadata.session_id`。可用配置 `knowledgePages: false` 整体关掉这两个工具。

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
| **插件管理（配置）** | DSH → 插件 → `dsh-hindsight-memory` → 详情页 →「配置」（插件自带的 client 半体渲染） | 逐项查看并修改插件配置（服务地址、记忆库、作用域、预算、只读/读写、自动召回/留存…）。配置写错**不会炸 profile**——非法输入一律回落到默认值 |
| **终端状态面板** | `node scripts/panel.mjs` | 服务健康、记忆库清单、**分层条数**（全局层 / 本项目层 / 其它项目层）、最近事实与其标签；项目标签按 omp 同规则自动推导，也可用 `--project <名字>` 覆盖 |
| **官方前端（最详细）** | <http://127.0.0.1:9999> | Hindsight Control Plane：知识页、实体、关系图、原始事实、库管理 |

> **插件里的「配置」按钮从哪来**：DSH 的插件配置表单**不会自动渲染**。宿主只在某个 client 半体注册了 `plugins.row.config`（键 = `<包名>#<行 id>`）或 `plugins.bundle.config`（键 = `<包名>`）渲染槽位时才给出入口。本插件的 client 半体（`src/ui-client.js`，浏览器经典脚本）同时注册了这两个槽位，所以详情页会出现可编辑表单。
>
> **表单要拿到「可编辑配置项」还差一格（v0.3.0 修的就是这格）**：宿主只会把**运行中**且**字段被标成 volatile** 的插件行投影成可编辑配置项（`dsh-settings` 的 `volatileForm()` 会把非 volatile 字段整段裁掉）。少任何一样，详情页就只写「这个插件行还没有被宿主暴露为可编辑配置项 (settings namespace 未就绪)」——插件照常工作，只是没有表单。本插件的做法与 `dsh-mnemon` 一致：`src/schema.js` 导出 `LiveConfig`（把基础 schema 逐字段 `.volatile()`），并在 `loader/volatile-update` 里把改动**写回运行中的配置引用**（宿主改的是引用里的值，不是替换对象 ⇒ 插件必须每次读当前值，否则拿到的是包装对象）。
>
> ⚠️ **改完 client 半体必须重启 DSH Web**：DSH 进程在启动时解析每个包的 `package.json` 并把结果**缓存在进程内**（不随磁盘变化失效），所以「装了带 client 半体的新版本 → 刷新页面看不到配置按钮」是预期行为，重启一次即可，别去反复点开关。

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

**从插件市场发现页装**：DSH → 插件 → 发现 → 索引源，填本仓库的索引地址：

```
https://raw.githubusercontent.com/meisijiya/dsh-hindsight-memory/main/index.json
```

索引里锁的是**精确 commit**（不是浮动 HEAD）；改索引只要重新拉取，不用重启 DSH。索引格式与发布流程见 `docs/market-index.md`。

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
        hygieneThreshold: 0.9        # 近重复判定阈值（越高越保守）
        hygieneMaxFacts: 500          # 单次扫描的事实条数上限
        hygieneProjectMission: '只保留该项目中长期有效的技术决策、约定、硬约束与踩过的坑；不保留一次性进度、临时状态与重复表述。'
        hygieneProjectMaxObservations: 40   # 项目层每个 scope 的 observation 上限
        hygieneGlobalMission: '只保留跨项目长期有效的约定、环境事实与用户偏好；不保留一次性进度、临时状态与重复表述。'
        hygieneGlobalMaxObservations: 30   # 全局层 observation 上限
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

## 隔离分层观测（怎么验证「隔离真的按预期分层」）

```bash
node scripts/isolation-check.mjs --a "D:/26code/随便问问" --b "D:/26code/测试hindsight"
```

脚本用**两个项目目录**写三条探针（项目A 事实 / 项目B 事实 / 全局层事实），然后打出可见性矩阵，
观测完自动作废探针（`--keep` 可保留）。2026-10-22 实测结果（DSH 插件侧，走插件自己的读写路径）：

| 观察者 | scope | A 层 | B 层 | 全局层 |
| --- | --- | :---: | :---: | :---: |
| 项目A（随便问问） | project（项目层+全局层） | ✅ 可见 | ❌ 不可见 | ✅ 可见 |
| 项目A | project_only（仅项目层） | ✅ 可见 | ❌ 不可见 | ❌ 不可见 |
| 项目A | global（仅全局层） | ❌ 不可见 | ❌ 不可见 | ✅ 可见 |
| 项目B（测试hindsight） | project（项目层+全局层） | ❌ 不可见 | ✅ 可见 | ✅ 可见 |
| 项目B | project_only（仅项目层） | ❌ 不可见 | ✅ 可见 | ❌ 不可见 |
| 项目B | global（仅全局层） | ❌ 不可见 | ❌ 不可见 | ✅ 可见 |

同一结论用**真实 omp 客户端**复核过（读 omp 会话文件里注入的 `<memories>` 块，不采信模型自述）：

| omp 运行的目录 | 注入条数 | 看到的探针 | 看不到的探针 |
| --- | --- | --- | --- |
| `D:\26code\测试hindsight` | 16 | 项目B 层 + 全局层 | 项目A 层 |
| `D:\26code\随便问问` | 17 | 项目A 层 + 全局层 | 项目B 层 |

整库分层（87 条活跃事实）按两个目录各看一次：

| 视角 | 全局层（无 tag） | 本项目层 | 其它项目层 |
| --- | --- | --- | --- |
| 随便问问 | 29 | 58 | 0 |
| 测试hindsight | 29 | 0 | 58 |

> 结论：**项目隔离靠标签，不靠库名**；同一块 `shared` 库里，靠 `project:<仓库名小写>` 区分项目层、
> 靠「无 tag」区分全局层。DSH 与 omp 读写同一批数据、各自只看自己该看的那一层。

## 记忆卫生（共享 bank 层，两端同时受益）

**omp 自己没有清理能力**（实测：omp 二进制里没有任何去重/整理逻辑，只有 retain/recall/reflect）。
所以「记忆越写越胖、召回里出现四五条近义重复」这件事，**必须由中间层在共享 bank 上做**——
只有这样 omp 与 DSH 才不会行为分裂（整理一处，两端同时受益；整理在某一侧做 ⇒ 立刻分裂）。

分两层，各管一段：

| 层 | 谁在做 | 管什么 | 状态 |
|---|---|---|---|
| **服务端自动** | Hindsight 本体（bank 级配置） | observation 归纳层的口径与上限：项目层 scope 用 `consolidation_strategies`（口径 + 上限 40），全局层用 bank 级 `observations_mission` + `max_observations_per_scope=30`；`enable_auto_consolidation=true` | 已在本机 `shared` 库启用 |
| **客户端整理** | 本插件 `memory_hygiene` 工具 + `scripts/hygiene.mjs` | world 原始事实的**近重复清理**（服务端不提供 world 去重） | 工具与脚本已就绪，可预览/执行 |

```bash
# 只读预览（默认）
node scripts/hygiene.mjs --bank shared --threshold 0.8

# 真正作废近重复事实（服务端可逆：state 改回 valid 即恢复）
node scripts/hygiene.mjs --threshold 0.8 --apply

# 顺带触发服务端合并 observation
node scripts/hygiene.mjs --consolidate
```

工具版：`memory_hygiene(action=preview|prune|consolidate|scopes|strategies-preview)`，`prune` 默认 `dryRun=true`。

**去重规则（三条护栏，缺一条就会误伤）**

1. **只在同一层内找重复**：项目层与全局层语义不同，同文也不同义 ⇒ 分组签名 = `fact_type + 标签集`。
2. **不动 observation**：服务端每次 retain 会同时产出 world 原始事实与 observation 归纳事实，两者文本高度相似但语义不同；把归纳层当重复删掉＝删掉归纳成果（默认跳过，`--include-observations` 才纳入）。
3. **每组保留最新的一条**，其余作废；作废是**可逆**的（`PATCH /memories/{id} {"state":"invalidated"}` → `{"state":"valid"}` 即可恢复）。

**2026-10-22 实测**：93 条活跃事实 → 清理 6 条近重复 → 触发 consolidation（服务端返回 `deduplicated: true`）→ 88 条活跃；
召回命中 14 条、近重复组 **0**；`node scripts/verify-live.mjs` **8/8 通过**（分层可见性、跨项目硬隔离负例 count=0 全部复验）。

> 阈值怎么选：`0.9` 只抓逐字重复；`0.8` 能抓「同一件事换个说法」（本机这轮的真实情况）；`0.7` 起要人工看一眼再下手。

## 精神模型（mental models）：跨会话的经验总结

omp 在启动时会幂等建三个 mental model（本插件对齐了同样的三件套）：

| 模型 | 标签 | 作用 |
|---|---|---|
| `dsh-user-preferences` | **无标签**（全局层，所有项目可见） | 用户的长期偏好 |
| `dsh-project-conventions-<完整项目名>` | `project:<项目名小写>` | 本项目的约定 |
| `dsh-project-decisions-<完整项目名>` | `project:<项目名小写>` | 本项目的决策 |

**为什么 id 要带前缀 + 完整项目名**：omp 的 id 规则是「只保留 ASCII 字母数字」，
所以纯中文项目名在 omp 侧会全部退化成 `project-conventions-project`——多个中文项目会抢同一个模型，
实测其中一个还带着别的项目的标签。DSH 侧改用 `dsh-` 前缀 + **完整中文项目名**，
服务端不强制 id 只能 ASCII（实测中文 id 创建成功），这样 DSH 与 omp 的模型**互不覆盖**。

> ⚠️ 服务端 `POST /mental-models` 是**仅创建**：重复 id 返 `409` 且**不改写已有 tags**。
> 所以插件的做法是「缺就建、标签不对就 PATCH、对的就原样保留」——`planEnsure()` 干这件事。

```bash
# 插件工具：memory_mental_models(action=ensure|list|content|refresh|patch)
```

**实测（2026-10-22，bank `shared`）**：`ensure` 返回 `created:0 patched:0 kept:3`，
三个模型齐全，`dsh-user-preferences` 标签为空（全局层）、两个项目模型带 `project:随便问问`。

## 运维观测：失败任务不会自动重试

Hindsight 的抽取/刷新/合并任务都进 `operations` 队列，**失败不会自动重试**
（`retry_count` 不涨、`next_retry_at` 为空）。所以必须有观测手段，否则「记忆写不进去」会静默。

```bash
# 插件工具：memory_operations(action=list|retry|delete)
```

`memory_status` 里已经带了队列体检：按状态/任务类型统计 + 最近任务的 `error` 与 `retryCount`。
实测：`total 248 / processing 8 / completed 11 / failed 1`，那条 failed 是探针 mental model 被删后
遗留的 `refresh_mental_model`（`ValueError: Mental model probe-mm-测试 not found`）。

> 排查「召回为空」的第一步：`memory_status` 里的 `bank.factCount` 与 `bank.warnings`
> ——**同名空 legacy bank 会伪装成零结果**，先核对 bank 名字再下结论。

## 知识页与 initiative（服务端原生能力，本插件只做对齐）

Hindsight 服务端自带 `/knowledge-base`（页 + 文件夹 + 全文检索）。本插件把它包成两个工具，
**沿用与 omp 完全一致的写入纪律**：

| 动作 | 落库形态 | 标签 | 写入方式 |
|---|---|---|---|
| `memory_pages action=create` | 一页（服务端按 `source_query` 异步合成正文） | `project:<小写项目名>` | `POST /knowledge-base/pages`，409 视作已存在 |
| `memory_initiative action=capture` | 一页 + 一条标记事实（`context` 里带 `[[page:<id>]]` 互链） | 页：`project:<小写项目名>` + `knowledge:feature-work`；事实：`project:<小写项目名>` | 页同上；标记事实走 `async:true` + `metadata.session_id` |

三条守则（与 omp 对齐的具体含义）：

1. **产出必须盖本项目标签** —— 不盖标签的页 omp 的 `per-project-tagged` 召回看不见（它只认「无标签」或「带本项目标签」）。
2. **不复用官方的 `source:`/`harness:` 标签** —— 那两个前缀是官方包的 provenance，混进来会让 DSH 侧按白名单过滤时把自家内容挡掉。
3. **写操作异步 + 带 `metadata.session_id`** —— 页正文要等服务端合成（实测几十秒到几分钟），刚建完立刻 search 可能只拿到 `No content yet.`。

实测（v0.5.0，bank `shared`）：

```
memory_pages list      → ok, folders=[], pages=[]
memory_pages create   → ok, pageId=kp-…, operationId=41e2e487…（异步合成）
memory_pages search   → ok, count=1, snippet="No content yet."（合成未完成）
memory_initiative capture → ok, 自动建 Initiatives 文件夹 kf-…, 页 kp-…，标记事实 ok
memory_initiative list → ok, count=1, markers=[]（标记事实异步落库，1~2 分钟后才有）
```

> ⚠️ **标记事实是异步的**：`capture` 立刻返回 `marker: {ok:true}` 只代表**入队成功**，
> 事实真正落库要 1~2 分钟（服务端抽取 + 异步写）。刚 `capture` 就 `list` 看到 `markers: []` 是正常的，不是失败。

`knowledgePages: false` 可整体关掉这一层（工具在 apply 时决定是否注册，见「缓存稳定性」）。

## 开发

```bash
node --test "test/*.test.js"     # 70 个单测（Windows 上不能写 node --test test/，会被当成模块解析）
node scripts/validate-market-index.mjs    # 市场索引闸门（格式 1 契约 + commit 与版本号对账）
node scripts/verify-live.mjs    # 活体自检（需要 Hindsight 服务在跑，8 项检查）
node scripts/panel.mjs          # 状态面板（项目标签自动按 omp 同规则推导）
node scripts/hygiene.mjs        # 记忆卫生（默认只读预览；--apply 才作废，--consolidate 顺带合并）
node scripts/isolation-check.mjs --a <项目目录> --b <另一个项目目录>   # 两项目隔离可见性矩阵
```

## 已知差异（与 omp 的诚实账）

- 召回注入载体是 DSH 的**用户消息**，omp 是 `<memories>` 背景块——形状已对齐，载体不同。
- 自动召回结果未持久化进 session 文件，resume 会重查一次（omp 会重放缓存块）。
- 自动留存是「本回合文本」简化版，未实现 omp 的 full-session 整段重发 + `document_id=sessionId`；
  节奏已对齐（每 `retainEveryNTurns`=3 回合一次）。
- DSH 侧**纯全局层读取**需要「整库读 + 客户端过滤」（服务端没有「只取无标签」的表达）。
- omp 自己**产不出全局层**（它的 retain 恒带 `project:` 标签）；全局层目前只由 DSH 侧不传标签写入。
- 精神模型：DSH 与 omp 各建各的（id 前缀不同、互不覆盖）；**DSH 侧不会去改 omp 建的模型**。
- mental model 刷新要能跑完，得同时放宽服务端三个超时（`REFLECT_WALL_TIMEOUT` / `LLM_TIMEOUT` / worker 存活），
  客户端改不了；本机已把服务端超时放宽（1800/600/600）。

## 排障（踩过的坑，别重复踩）

| 症状 | 根因 | 处理 |
|---|---|---|
| 插件管理页里找不到「配置」按钮 | client 半体没装载：DSH 启动时解析 `package.json` 的 `dsh.client` 并**进程内缓存**，之后改磁盘不会生效 | **重启 DSH Web**（唯一可靠路径） |
| `GET /plugins/dsh-hindsight-memory/client.js` = 404 | 同上：该包在 client 图里没有记录 | 重启后应 200 |
| 插件被误关（卡片显示 disabled） | 插件管理页的开关 = 增删 profile `package.json` 里 `dsh.profile.bundles` 数组里的包名 | 手动把包名加回 `dsh.profile.bundles`（依赖本身不需要重装） |
| 升级后行为没变 | git 依赖不会自动更新 | 在 profile 目录执行 `pnpm update dsh-hindsight-memory --latest` |
| 终端面板「其它项目层」恒为 0 | 过滤条件把非本项目标签的事实也算成本项目 | 过滤应为「有标签 且 不含本项目标签」 |
| `node --test test/` 报 MODULE_NOT_FOUND | Windows 上 `test/` 被当成模块路径 | 写 `node --test "test/*.test.js"` |
| 中文 bank id 报 400 / 建出乱码库 | bash 内联 curl 传中文 body 会坏；URL 需 percent-encode | body 写文件后 `--data-binary @file`；路径用 `urllib.parse.quote` |
| Hindsight 容器起不来（`Unknown reranker provider: none`） | `none` 不是合法的 reranker provider | 用 `rrf`（直通不重排） |
| 启动日志出现 `failed to import: ReferenceError: Config is not defined` | `export { LiveConfig as Config }` 只是**再导出**，模块作用域里没有 `Config` 绑定，默认导出里引用它就炸 | v0.3.1 已修：默认导出写 `Config: LiveConfig`；并加了 `test/entry.test.js` 钉住"入口必须能被 import" |
| 启动日志 `dsh: warning: N entry did not activate` | 该插件行加载失败 ⇒ 整行静默不生效（功能全没了但没有报错弹窗） | 看同一条日志里的 `failed to import:` 原文，它才是真线索 |
| 插件在「插件 → 发现」里整个不见了 | 索引里 `source.commit` 写了 7 位短 sha ⇒ 宿主要求 40 位小写 hex，整份索引被拒 | `node scripts/validate-market-index.mjs` 按 FAIL 项修；详见 `docs/market-index.md` |
| 想验证插件在宿主里的真实加载情况 | 不能重启正在服务当前会话的 DSH 实例 | 用 `dsh headless --patch <overlay>.yml "…"` 旁路验证；注意 `dsh --profile web` 起的第二实例会和用户实例抢 3080/3081 端口 |

## 版本沿革

| 版本 | 内容 |
|---|---|
| 0.1.0 | 首个可运行版本：四个封装工具 + omp 契约对齐（盖章/过滤/预算/异步语义） |
| 0.2.0 | 记忆卫生层：`memory_hygiene` 工具 + `src/hygiene.js` + bank 级 consolidation 配置 + 终端面板卫生板块 |
| 0.3.0 | 把插件行投影成宿主可编辑配置项：`LiveConfig`（全部字段 `.volatile()`）+ `unwrapConfig` + `loader/volatile-update` 热更新 |
| 0.3.1 | 修 v0.3.0 引入的入口 `ReferenceError`（默认导出引用了不存在的 `Config` 绑定）→ 补 `test/entry.test.js` 契约测试 |
| 0.4.0 | 对齐 omp 报告：新增**精神模型**层（`memory_mental_models`）+ **运维观测**（`memory_operations`）+ `memory_status` 的 bank 体检与队列体检；`memory_hygiene` 支持按层 `scope`；写入补本地时区 `timestamp` + `metadata.session_id`；自动留存对齐 omp 的 `retainEveryNTurns=3`（原来每轮都写，项目层被灌到 137 条） |
| 0.5.0 | 搬入**知识页**层（`memory_pages`）与 **initiative** 登记（`memory_initiative`）：服务端 `/knowledge-base` 原生能力，产出盖项目标签、不复用 `source:`/`harness:`、写入 async + `metadata.session_id`；新增 `src/pages.js` + 13 条单测；配置 `knowledgePages` 可整体关掉 |
