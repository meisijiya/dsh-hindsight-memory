# ENGINEERING.md —— dsh-hindsight-memory 开发规范与测试流程

本仓库是一个 DSH 插件（个人自研），把 Hindsight 记忆服务接进 DSH，并与另一个 agent（omp）对齐读写语义。
它同时被 DSH 与 omp 使用，且直接接触用户记忆数据，所以工程要求比"能跑就行"高出一档：
**行为可预期、契约可回归、变更可追溯**。

本文档是本仓库的规范正文。提交 PR 前请通读一遍；贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 1. 仓库结构与分层

```
src/        插件实现（ESM，Node 22）
  config.js        配置归一化（纯函数层）
  schema.js        配置 schema（动态 import schemastery，带降级）
  label.js         项目标签推导（纯函数层）
  parity.js        与 omp 对齐的语义计算（纯函数层）
  sanitize.js      输入清洗（纯函数层）
  prompt.js        常驻提示词段（纯函数层，编译期常量）
  hygiene.js       记忆卫生策略（纯函数层）
  pages.js         知识页策略（纯函数层）
  mental-models.js 精神模型策略（纯函数层）
  mcp.js           MCP 协议编解码（纯函数层）
  client.js        Hindsight 服务访问（I/O 层）
  index.js         插件入口：注册工具、挂事件（I/O 层）
  ui-client.js     插件管理页前端
test/       node:test 测试（test/*.test.js）
scripts/    本地脚本（panel / hygiene / verify-live / validate-market-index / isolation-check）
docs/       设计文档
```

**纯函数层**（`src/hygiene.js`、`src/pages.js`、`src/mental-models.js`、`src/parity.js`、`src/sanitize.js`、`src/prompt.js`、`src/config.js`、`src/label.js`、`src/mcp.js`）不碰网络、文件系统、时钟随机性以外的副作用，可被单测直接断言。
**I/O 层**（`src/client.js`、`src/index.js`）负责 HTTP、插件生命周期、事件订阅。

---

## 2. 分支与提交规范

### 2.1 分支

- `main` 受保护：**禁止直接 push**，所有改动走 PR。
- 功能分支命名：`feature/<简述>`、`fix/<简述>`、`docs/<简述>`、`chore/<简述>`、`test/<简述>`，简述用英文小写短横线，例如 `feature/knowledge-pages`。
- 分支从最新 `main` 切出，尽量短命（一个分支一件事），合入后删除。
- 合并方式：squash merge，保持 `main` 上一个变更一个提交。

### 2.2 提交信息（Conventional Commits）

格式：`<type>(<scope>): <祈使句描述>`，scope 可省略。

允许的 type：

| type | 用途 | 例子 |
| --- | --- | --- |
| `feat` | 新功能（新增工具、新增配置项、新增能力） | `feat(pages): 增加知识页创建入口` |
| `fix` | 缺陷修复 | `fix(entry): 修默认导出引用不存在的 Config 绑定` |
| `docs` | 文档、README、注释 | `docs(design): 补 recall 请求体字段说明` |
| `test` | 只改测试 | `test(parity): 锁定 recall 请求体字段集合` |
| `refactor` | 不改行为的结构重构 | `refactor(hygiene): 拆出纯函数便于单测` |
| `chore` | 杂项（索引、发布准备） | `chore(market): 发布 0.5.0 索引条目` |
| `build` | 构建/打包/依赖 | `build: 打包 0.5.0 tarball` |
| `ci` | CI 配置 | `ci: 增加索引校验流水线` |
| `perf` | 性能优化 | `perf(client): 复用连接减少握手` |

规则：

- 描述用祈使句，中文或英文均可，但同一仓库内保持一致；正文说明「为什么改」，不是「改了什么」。
- 一个提交只做一件事；破坏性变更在正文用 `BREAKING CHANGE:` 段落说明。
- 提交前必须本地跑过第 6 节的质量门禁。

---

## 3. 版本策略

- 遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`MAJOR.MINOR.PATCH`。
- **当前处于 0.x 阶段**：`MINOR` 递增代表**破坏性变更**，`PATCH` 只用于向后兼容的修复与新增可选能力。
  - 例：`0.5.0 → 0.6.0` 表示不兼容的行为变化（即使听起来只是"加了个功能"，只要改了既有行为就算）。
  - 到了 `1.0.0` 之后，改用标准 SemVer：`MAJOR` = 破坏性、`MINOR` = 向后兼容新增、`PATCH` = 修复。
- **插件的公共 API（对外契约）**包括且不限于：
  1. 对外暴露的工具名与数量（`memory_recall` / `memory_retain` / `memory_reflect` / `memory_status` / `memory_hygiene` / `memory_mental_models` / `memory_operations` / `memory_pages` / `memory_initiative`）；
  2. 插件配置键集合与取值范围（`src/config.js` 的 `DEFAULTS` / `normalizeConfig`）；
  3. 配置 schema 的字段与说明（`src/schema.js`）；
  4. 对 Hindsight 服务的请求形状与语义（recall 请求体字段、retain 的 tags/metadata 规则、禁止改写共享 bank 的 mission）；
  5. 注入到会话里的提示词段落 `MEMORY_PROTOCOL`（`src/prompt.js`）。
- 公共 API 的任何变更（增删工具、改配置键、改字段、改提示词段）**必须**：
  1. 同步更新 `CHANGELOG.md`（仓库当前尚未建立该文件，首次发布时按本节格式创建；每条写清「改了什么 / 为什么 / 对使用方的影响 / 迁移方式」）；
  2. 同步更新第 5.2 节的契约测试；
  3. 在 PR 描述里显式声明「影响公共 API：是 / 否」。
- 版本号只在发布时改动（见第 10 节），不要在功能分支里提前 bump。

---

## 4. 通用代码规范

### 4.1 依赖

- **核心逻辑零运行时依赖**：`src/` 的实现只允许使用 `node:` 内置模块。
  仓库里唯一的 `dependencies` 条目 `@deepseek-ai/schemastery` 属于**可选增强**：只能通过 `import()` 动态加载，并且必须有降级路径（见 `src/schema.js`），拿不到时插件必须照常装载。
- 新增任何依赖前先在 PR 里说明理由（宿主无法解析 profile 的 `node_modules`，依赖越多插件越脆）。
- 脚本（`scripts/`）同样优先零依赖。

### 4.2 类型与断言

- 用 JSDoc 标注函数签名（`@param` / `@returns`），关键结构体额外写 `@typedef`。
- **禁止 `any` 式宽松类型**：不要用 `any`、不要用 `/* eslint-disable */` 逃逸、不要用空的 `@returns {any}`。
  拿不准时用联合类型或 `unknown` + 显式收窄。
- 断言要具体：优先 `assert.equal` / `assert.deepEqual` / `assert.ok`，失败信息要能指出"哪条契约、哪个值"。
- 不允许为了让测试通过而放宽断言（例如把 `deepEqual` 换成 `ok`）。

### 4.3 错误处理

- **一切错误都要包成可读消息再抛出或返回**：包含「哪个操作失败 / 原因 / 建议动作」。
  - 反例：`throw error`（宿主只看到 stack）、`catch {}`（吞掉）。
  - 正例：`throw new Error(\`recall 失败（bank=${this.bankId}）：${res.status} ${res.statusText}\`)`。
- 面向工具调用的失败一律返回结构化错误（工具响应里的 `ok: false` + 中文原因），不要抛未捕获异常把整轮请求带崩。
- 日志只记必要上下文，不要把用户记忆原文打进日志。

### 4.4 函数与分层

- **单一职责**：一个函数只做一件事；超过 ~40 行或出现第二层嵌套，就该拆。
- **纯函数与 I/O 分离**：策略判断（打标签、分层、过滤、拼装、渲染）放纯函数层并接受参数；HTTP、文件、时钟、随机数留在 I/O 层。纯函数才能被单测稳定断言。
- 导出面尽量小：只导出被别处真正使用的符号。
- 命名直白：`normalizeConfig` 好过 `processCfg`。

### 4.5 注释

- 注释与文档**用中文**。
- 写「**为什么**」，不写「做了什么」：
  - 反例：`// 遍历 facts 数组`（代码自明）。
  - 正例：`// 为什么自己解析而不引 schemastery：插件可能被以 file:// 方式加载，那时从插件目录起算的 ESM 解析链拿不到 profile 的 node_modules。`
- 踩过的坑、协议约束、兼容性原因必须留注释，防止后人"顺手优化"掉。

### 4.6 格式

- 缩进用 **tab**（宽度 4），UTF-8，LF 换行，文件末尾留空行，删除尾随空格（见 `.editorconfig`）。
- 不引入格式化/lint 工具链；风格靠本节与 `.editorconfig` 约束，保持零依赖。

---

## 5. 测试分层与要求

测试文件统一放 `test/*.test.js`，用 Node 内置的 `node:test` + `node:assert/strict`，无第三方测试框架。

### 5.1 L1 —— 纯函数单元测试

- 覆盖 `src/` 纯函数层：`config.js`、`label.js`、`parity.js`、`sanitize.js`、`prompt.js`、`hygiene.js`、`pages.js`、`mental-models.js`、`mcp.js`。
- 要求：每条断言对应一条可写清的规则；非法输入必须有"回落默认值而不抛错"的用例。
- 禁止在单测里访问网络、真实文件路径、真实时钟（时间用可注入的固定值）。
- 已有文件参考：`test/unit.test.js`、`test/hygiene.test.js`、`test/pages.test.js`、`test/mental-models.test.js`。

### 5.2 L2 —— 契约测试（锁死"对外行为"）

契约测试的意义是：**改动可以，但必须是有意识的改动**。以下事实一旦定下，变更即视为破坏性变更，必须走第 3 节流程：

| 契约 | 断言内容 | 位置参考 |
| --- | --- | --- |
| recall 请求体 | 字段数量与字段集合固定（与 omp 对齐，仅 6 个字段），不得私自增删 | `test/parity-omp.test.js` |
| 不得改写共享 bank | 源码中**不存在** `PUT /banks`（DSH 侧不得覆写共享 bank 的 mission） | `test/parity-omp.test.js` |
| 工具注册 | apply 时一次性注册的工具**数量与名字**固定；运行期不得增删 | `test/entry.test.js` |
| 配置键集合 | `DEFAULTS` / `normalizeConfig` 的键集合固定，非法值回落默认值 | `test/schema.test.js`、`test/unit.test.js` |
| schema 字段 | 字段数量固定、每个字段都有说明文案、`LiveConfig` 全部标 `volatile` | `test/schema.test.js` |
| 索引条目 | `index.json` 为 format 1、版本号精确 SemVer、`commit` 必须是 40 位小写 hex、最新版本与 `package.json` 一致 | `test/market-index.test.js` |
| 与 omp 的语义 | 分层可见性、标签盖章、全局层判定等 | `test/parity.test.js`、`test/parity-omp.test.js` |

规则：

- 契约测试**只允许在有意识地做破坏性变更时修改**，且同一个 PR 里必须同时改实现、改契约测试、改 `CHANGELOG.md`。
- 契约测试失败时先问"是不是行为真的变了"，而不是"把断言改松"。

### 5.3 L3 —— 活体验证（冒烟级，本地跑，CI 不跑）

- 脚本：`scripts/verify-live.mjs`（`npm run verify:live`）。
- **前置条件**：本机有一个活着的 Hindsight 服务（默认 `http://127.0.0.1:8888`，bank `shared`）。
- 等级：**冒烟**。它依赖外部服务与异步抽取，天然不稳定（服务端繁忙时可能假阴性），因此**不进 CI**，只作为发布前与改动底层读写路径后的本地验证。
- 断言口径：只认服务端返回的原始数据（REST 列表 / recall 结果），**不认模型自述**。
- 相关的其它本地脚本（同样不进 CI）：
  - `scripts/panel.mjs`（`npm run panel`）：终端版状态面板，看分层/条数/隔离。
  - `scripts/hygiene.mjs`：记忆卫生 CLI（`--apply` 才写、`--consolidate` 触发服务端合并）。
  - `scripts/isolation-check.mjs`：用两个项目目录实测分层可见性矩阵。
- 辅助脚本 `scripts/validate-market-index.mjs`（`npm run verify:market-index`）是**离线**的，进 CI。

### 5.4 测试写法约定

- 用 `test("一句话描述被锁定的规则", ...)` 命名，名字里写清"什么行为"，不写"测试 xx 函数"。
- 一个 `test()` 只锁一条规则；相关规则可放在同一文件里。
- 失败信息要能自解释：断言消息里带上期望值与实际值。
- 修 bug 时先补一条能复现的失败用例，再改实现。

---

## 6. 质量门禁清单

### 6.1 提交前（本地必过，缺一不可）

```bash
node --test "test/*.test.js"          # 1) 单元 + 契约测试全绿
for f in src/*.js; do node --check "$f"; done   # 2) 全部源码可被 Node 解析
node scripts/validate-market-index.mjs # 3) 插件市场索引格式与事实校验
```

等价写法：`npm test`（脚本 `test`）与 `npm run verify:market-index`（脚本 `verify:market-index`）。

> `node --test` 必须**零失败**；跳过（skip）不允许掩盖红灯。测试因环境原因无法运行时，在 PR 里说明并附上"已在本地通过"的证据。

### 6.2 CI 镜像

`.github/workflows/ci.yml` 与 6.1 保持一致，另加：

- Node 22（对齐 `engines.node >=22.6.0`）；
- 两条流水线：`(a) 单元与契约测试`、`(b) 插件市场索引校验`；
- 只读权限（`permissions: contents: read`）与并发组（同分支新推送取消旧构建）；
- 索引校验若因宿主侧可选依赖缺失而无法运行，退化为 `node --check scripts/validate-market-index.mjs` 语法兜底，索引内容契约由 `test/market-index.test.js` 兜底。

### 6.3 发布前（本地 + profile 侧，必过）

```bash
pnpm update dsh-hindsight-memory --latest   # profile 侧能装通（版本可解析、peer 依赖不冲突）
dsh headless --patch                        # 至少一次旁路活体验证：插件能装载、工具能调、记忆能读能写
```

- `--patch` 旁路运行是为了不污染当前 profile 配置；验证内容至少包括：插件加载无异常、工具列表符合契约、一次 recall 与一次 retain 往返正常。
- 再叠加一次 `node scripts/verify-live.mjs` 的冒烟验证（L3）。

---

## 7. 缓存稳定性红线（🔴 不可协商）

这套插件跑在带 prompt cache 的适配器上，**工具集合与系统提示词段位于缓存前缀**。踩坏缓存的代价是每轮请求成本暴涨甚至整轮作废。

**红线 1 —— 工具只在插件 apply 时注册一次。**
工具集合、工具名、工具参数 schema 在一次会话内必须恒定。增删工具会让**没有 toolUpdate 能力的适配器**重开请求序列 ⇒ 缓存作废。
因此：不要在运行期按配置动态增删工具；确需裁剪（例如关掉知识页层）必须在 apply 时一次性算好并注册最终集合，且集合数量是契约的一部分。

**红线 2 —— 系统提示词 section 必须是编译期常量。**
`systemPrompt.section` 的文本每一步都会被重新求值，而它位于 surface node 0（缓存前缀里）。任何随回合变化的内容（时间戳、当前项目名、召回结果、随机 id）写进去，都会让前缀每步都变。
因此：`src/prompt.js` 里的提示词段必须是常量字符串，不含时间、项目名、记忆内容。

**红线 3 —— 随回合变化的内容只能走 `agent/pre-step` 注入的用户消息。**
变化的东西只有两条合法出路：
① 作为**工具参数**由模型每次调用时现传；
② 作为 **用户消息**由插件在 `agent/pre-step` 注入（落在缓存边界之后，例如首轮自动召回结果）。

**红线 4 —— 提示词段关闭插值。**
DSH 会对 section 文本做 `{{var}}` 插值，未知引用会抛错、整轮请求报废 ⇒ 提示词段必须 `interpolate: false`，且文本里不得出现 `{{...}}` 形态的字面量。

**红线 5 —— 改了红线相关内容，等于改公共 API。**
按第 3 节走：更新 `CHANGELOG.md`、更新契约测试、在 PR 中声明影响公共 API。

---

## 8. 缺陷分级与修复时限

| 级别 | 判定标准 | 处理时限 |
| --- | --- | --- |
| **P0** | 数据损坏或泄漏：记忆写错库/写错层、用户数据外泄、bank 被错误改写 | 立即停止发布，24 小时内给出修复或回滚；先发补丁版本，再补根因分析 |
| **P1** | 行为错误：工具报错、读写方向反了、分层可见性错误、与 omp 语义不一致 | 1 个工作日内定位，3 个工作日内合入修复并补回归测试 |
| **P2** | 体验问题：参数难用、报错信息不可读、性能偏慢但结果正确 | 两周内排期，随下一次迭代处理 |
| **P3** | 文档与注释：说明缺失、注释过期、README 与实现不同步 | 一个月内处理，或随下一个相关改动一并修掉 |

规则：

- 缺陷分级写入 issue 标题前缀：`P0/`、`P1/`、`P2/`、`P3/`。
- P0/P1 的修复必须附带**能复现的失败用例**（进 `test/`），并说明回归风险。
- 任何级别缺陷修复后，都要重跑第 6.1 节的质量门禁。

---

## 9. 提交与评审

- PR 标题用 Conventional Commits，与 squash 后的提交标题保持一致。
- 一个 PR 只做一件事；跨层改动（实现 + 契约 + 文档）要在描述里列清楚。
- 评审关注点按优先级：公共 API 是否被无声改动 → 缓存红线是否被破坏 → 契约测试是否同步 → 错误消息是否可读 → 注释是否解释了"为什么"。
- 合入前必须满足：CI 绿 + 本地 6.1 门禁绿 + PR 描述三要素齐全（变更说明 / 测试证据 / 是否影响公共 API）。

---

## 10. 发布流程

1. **改版本号**：`package.json` 的 `version`（0.x 阶段按第 3 节判定 minor 还是 patch）。
2. **更新 `CHANGELOG.md`**：写清本次变更、原因、对使用方的影响、迁移方式；若涉及公共 API 变更，单独标注。
3. **跑质量门禁**（6.1 全过；涉及读写路径时补跑 6.3）。
4. **提交并推送**：`git commit` + `git push` 到 `main`（发布提交走 PR 合入）。
5. **升级 profile**：`pnpm update dsh-hindsight-memory --latest`，确认能装通。
6. **活体验证**：`dsh headless --patch` 旁路跑一次（至少一次），确认工具与读写正常；必要时补 `node scripts/verify-live.mjs`。
7. **更新 `index.json`**：新增版本条目。**`source.commit` 必须钉 40 位完整 sha**（`/^[0-9a-f]{40}$/`），不能用短 sha、不能用分支名、不能用 tag —— 宿主解析器会因此拒收整份索引，插件在「插件 → 发现」里直接消失。随后跑 `node scripts/validate-market-index.mjs` 校验，并把索引变更一并 commit。
8. **收尾**：确认 `package.json` 版本、`index.json` 最新版本、`CHANGELOG.md` 三者一致；需要发布 tarball 资产时用仓库既有的打包方式，产物不入库（`.gitignore` 已忽略 `*.tgz`）。

---

## 11. 命令速查（均为仓库中真实存在的脚本）

| 目的 | 命令 | npm script |
| --- | --- | --- |
| 单元 + 契约测试 | `node --test "test/*.test.js"` | `npm test`（`test`） |
| 插件市场索引校验 | `node scripts/validate-market-index.mjs` | `npm run verify:market-index`（`verify:market-index`） |
| 终端状态面板 | `node scripts/panel.mjs` | `npm run panel`（`panel`） |
| 活体验证（冒烟，需活服务） | `node scripts/verify-live.mjs` | `npm run verify:live`（`verify:live`） |
| 记忆卫生 CLI | `node scripts/hygiene.mjs` | 无（直接用 node 调用） |
| 分层隔离观测 | `node scripts/isolation-check.mjs` | 无（直接用 node 调用） |

> 除上表外，不要在文档、脚本或提交信息里引用仓库里不存在的脚本名或 npm script。
