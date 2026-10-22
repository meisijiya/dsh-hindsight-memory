# CONTRIBUTING.md —— 参与 dsh-hindsight-memory

感谢你愿意动手改这个插件。仓库不大，但它**同时被 DSH 和 omp 使用**，并且直接接触用户记忆数据，
所以我们希望每次改动都做到三件事：**行为可预期、契约可回归、变更可追溯**。

本文只讲「怎么参与」。规范正文（分支/提交/版本/测试分层/代码规范/缓存红线/缺陷分级/发布流程）在
[ENGINEERING.md](ENGINEERING.md)，**冲突时以 ENGINEERING.md 为准**。

---

## 1. 环境准备

| 项 | 要求 |
| --- | --- |
| Node.js | **>= 22.6.0**（`package.json` 的 `engines.node`；CI 用 Node 22） |
| 包管理器 | 仓库带 `pnpm-lock.yaml`；用 pnpm 或 npm 都行，插件本身零运行时依赖 |
| 编辑器 | 仓库带 `.editorconfig`：tab 缩进（宽度 4）、UTF-8、LF、末尾留空行、不留尾随空格 |

```bash
git clone https://github.com/meisijiya/dsh-hindsight-memory.git
cd dsh-hindsight-memory
node -v          # 确认 >= v22.6.0
```

插件本体不依赖 `node_modules` 就能跑（核心逻辑只用 `node:` 内置模块）。
如果你要跑完整测试或让配置表单渲染出富 schema，装一下依赖即可：

```bash
pnpm install     # 或 npm install
```

---

## 2. 本地跑测试与质量门禁

提交前请把下面三条都跑一遍（这是提交门禁，详见 ENGINEERING.md 第 6 节）：

```bash
node --test "test/*.test.js"           # 单元 + 契约测试必须零失败
for f in src/*.js; do node --check "$f"; done    # 全部源码可被 Node 解析
node scripts/validate-market-index.mjs          # 插件市场索引校验
```

等价的 npm script：`npm test`（`test`）、`npm run verify:market-index`（`verify:market-index`）。

想看记忆库现状（需要本机有活着的 Hindsight 服务，默认 `http://127.0.0.1:8888`）：

```bash
node scripts/panel.mjs          # 终端状态面板（npm run panel）
node scripts/verify-live.mjs    # 活体验证，冒烟级（npm run verify:live）
```

> 活体验证依赖外部服务与异步抽取，**CI 不跑它**，它只在本地跑；索引校验是离线的，所以进 CI。

---

## 3. 提 PR 的流程

1. **同步主分支**：`git checkout main && git pull`。
2. **切分支**：从最新 `main` 切出 `feature/<简述>` / `fix/<简述>` / `docs/<简述>` / `chore/<简述>`（短横线小写英文）。
3. **改代码 + 补测试**：纯函数改动补单测；对外行为改动必须同步改契约测试（ENGINEERING.md 第 5.2 节）。
4. **自查门禁**：跑完第 2 节的三条命令，全绿再推。
5. **提交信息**：`feat(scope): 描述` 这类 Conventional Commits 格式，type 取值见 ENGINEERING.md 第 2.2 节。
6. **推送并开 PR**：目标分支 `main`；PR 标题与 squash 后的提交标题保持一致。
7. **等评审**：评审关注点优先看「公共 API 是否被无声改动」和「缓存红线是否被破坏」。
8. **合入后**：删掉分支；若改动了公共 API，提醒维护者补 `CHANGELOG.md` 条目。

---

## 4. PR 必须包含什么

每个 PR 描述都要有这三块，缺一不可：

1. **变更说明**
   - 改了什么、为什么改（背景/根因，而不是复述 diff）。
   - 涉及文件路径与关键函数。
   - 是否触及公共 API：**工具名与数量、配置键集合、schema 字段、请求形状、提示词段**（详见 ENGINEERING.md 第 3 节）。
2. **测试证据**
   - 贴出实际跑过的命令与结果（至少：`node --test "test/*.test.js"` 的通过输出）。
   - 新增/修改了哪些测试用例，分别锁了什么规则。
   - 如果改动碰到读写路径，附上 `node scripts/verify-live.mjs` 或 `dsh headless --patch` 的旁路验证结果。
3. **影响面声明**
   - 「是否影响公共 API：是 / 否」。填「是」时，必须同时说明：契约测试怎么改、`CHANGELOG.md` 怎么写、用户怎么迁移。
   - 附上自检清单（下面第 6 节）。

---

## 5. 代码风格速查

完整版在 [ENGINEERING.md](ENGINEERING.md) 第 4 节，这里只记最常忘的几条：

| 项 | 规则 |
| --- | --- |
| 缩进 / 编码 | tab（宽度 4）、UTF-8、LF、末尾空行、无尾随空格 |
| 依赖 | 核心逻辑只用 `node:` 内置；确需依赖必须动态 `import()` 并带降级路径，装不上不能导致插件装载失败 |
| 类型 | JSDoc 标注签名；**禁止 `any` 式宽松类型**，也不要靠放宽断言让测试变绿 |
| 错误 | 一律包成可读消息（哪个操作失败 / 原因 / 建议动作），不吞异常，不把原始异常直接抛给宿主 |
| 分层 | 策略判断放纯函数层（`src/hygiene.js`、`src/pages.js`、`src/mental-models.js` 等），HTTP 与生命周期放 I/O 层（`src/client.js`、`src/index.js`） |
| 函数 | 单一职责，一个函数只做一件事 |
| 注释 | **中文**，写「**为什么**」而不是「做了什么」；踩坑与协议约束必须留注释 |
| 测试 | `node:test` + `node:assert/strict`，文件放 `test/*.test.js`，用例名写清被锁定的规则 |

---

## 6. 提交前自查清单

- [ ] `node --test "test/*.test.js"` 零失败（没有 skip 掩盖红灯）
- [ ] `for f in src/*.js; do node --check "$f"; done` 全过
- [ ] `node scripts/validate-market-index.mjs` 通过（若改了 `index.json`，`source.commit` 是 40 位完整 sha）
- [ ] 改了对外行为 ⇒ 契约测试已同步更新
- [ ] 改了公共 API ⇒ `CHANGELOG.md` 已更新，PR 描述已声明
- [ ] 没有破坏缓存红线：工具数量在一次会话内不变；系统提示词段是编译期常量；随回合变化的内容走 `agent/pre-step` 注入的用户消息
- [ ] 新增注释解释了「为什么」，没有删掉前人留下的踩坑说明

---

## 7. 问题反馈

- **提交 issue**：https://github.com/meisijiya/dsh-hindsight-memory/issues
- 标题请带分级前缀：`P0/`（数据损坏或泄漏）、`P1/`（行为错误）、`P2/`（体验问题）、`P3/`（文档）。分级定义见 ENGINEERING.md 第 8 节。
- 正文请给出：**复现步骤**、**期望行为**、**实际行为**、**环境**（DSH 版本 / Node 版本 / Hindsight 服务版本 / 是否有活服务），以及相关的错误消息原文。
- 涉及记忆内容的问题，请**脱敏后再贴**：不要贴记忆原文、bank id、任何 API key 或 token。
- 只想问用法、不想改代码：同样开 issue 并标 `P3/` 或在描述里说明是提问。

---

## 8. 许可

本项目采用 MIT 许可，见 [LICENSE](LICENSE)。提交贡献即表示同意按该许可发布。
