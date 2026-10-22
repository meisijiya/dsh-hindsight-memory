# 插件市场索引（`index.json`）

本插件同时挂在两个地方：**GitHub 仓库**（源码，`github:meisijiya/dsh-hindsight-memory`）与
**DSH 插件市场索引**（发现页，`index.json`）。两条路各有一份「版本」真相，索引那份最容易悄悄烂掉。

---

## 1. 症状：插件在「插件 → 发现」里根本不出现

宿主加载索引失败时**不会弹窗**，只在日志里留一句含糊的「索引加载失败」。
2026-10-22 的真实案例：索引里 `source.commit` 写的是 7 位短 sha `"7eb09bb"`，
宿主解析器要求 **40 位小写 hex** ⇒ 整份索引被拒 ⇒ 本插件在发现页消失。

```jsonc
// 错：短 sha，宿主正则 /^[0-9a-f]{40}$/u 直接不通过
"commit": "7eb09bb"
// 对：完整 40 位
"commit": "7eb09bb54df95c86b05f06ce9c53cd6f025bf96c"
```

**教训**：索引里任何一处不合规 ⇒ 整份索引作废（不是「跳过这一条」）⇒ 插件集体隐身。

---

## 2. 宿主契约（format 1 摘要）

权威实现：`@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex(document, indexUrl)`。

| 位置 | 规则 |
|---|---|
| `format` | 必须为 `1` |
| `title` / `description` | 至少含 `en`（可再加 `zh`）；`title` 必填 |
| `metadata.categories` | 分类字典，每个分类要有 `title`（含 `en`） |
| `plugins[].name` | 合法 npm 包名，全表不可重复 |
| `plugins[].metadata.category` | 必须在 `metadata.categories` 里声明过 |
| `plugins[].versions[]` | 非空数组；`version` 互不重复，且为**精确** SemVer |
| `versions[].publishTimestamp` | Unix 秒的**整数**，落在 `[0, 1e11)` |
| `versions[].source.type` | `"git"` 或 `"npm"` |
| `versions[].source.url`（git） | `https://` 规范仓库地址，至少两段路径 |
| `versions[].source.commit`（git） | **40 位小写 hex**（最容易踩的一条） |
| `versions[].engines.dsh` | 合法的 SemVer range |

宿主会把 `versions` 按 SemVer 降序重排，索引文件里写成什么顺序都不影响解析，但建议按降序写、读起来顺。

---

## 3. 闸门：`scripts/validate-market-index.mjs`

索引是纯声明式文件，改错不会有人报错 ⇒ 用脚本卡住。跑法：

```bash
node scripts/validate-market-index.mjs          # 人看
node scripts/validate-market-index.mjs --json   # 机器读
npm run verify:market-index                     # 同上，退出码非 0 即失败
```

三层校验：

1. **宿主解析器**（最高权威）：能找到 `@deepseek-ai/dsh-plugin-market-index` 就直接调它的
   `parseMarketIndex()`，规则跟宿主逐字一致；找不到就退回第 2 层并标记 `skip`。
2. **本地 format-1 规则**：零依赖、离线可跑，规则与第 1 层对齐。
3. **仓库事实**：每个版本的 commit 必须真实存在于本仓库，**且该 commit 上的 `package.json`
   版本号必须与索引里的版本号一致** —— 防止「版本号和 commit 对不上」这种最难发现的错。

每项输出 `PASS` / `FAIL` / `SKIP`，有 `FAIL` 时进程退出码为 1。

### 单测里也钉住了同样的规则

`test/market-index.test.js`（8 个用例，零依赖、零子进程 ⇒ 沙箱里也能跑）把关键契约写成断言：
commit 必须 40 位小写 hex、版本号精确 SemVer 且不重复、`publishTimestamp` 是 `[0,1e11)` 的整数秒、
`engines.dsh` 必填、索引最新版本必须等于 `package.json` 的 `version`。

> 注意：这条断言意味着**每次 bump `package.json` 的 version，都必须同步更新 `index.json`**，
> 否则 `npm test` 会红。这是刻意的：它挡的正是「版本号和索引对不上」这类不查就发现不了的错。

### 环境坑（Windows + DSH 沙箱）

- 宿主解析器装在 **DSH 本体的依赖树**里：
  `<全局根>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index`。
  插件自己的 `node_modules` 里没有，得按「全局根 + profile 根」分别去找。
- Windows 上动态 `import()` 绝对路径必须先转 `file://` URL（`pathToFileURL(...).href`），
  直接给 `D:\...` 会抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
- 沙箱（约束模式）里**命名管道不可用**，`execFileSync` 带 `stdio: "pipe"` 会 `EPERM`。
  脚本改成把 git 的 stdout/stderr 重定向到工作区内的临时文件再读回来 —— 文件描述符不是管道，放行。

---

## 4. 发布流程（改版本时照着走）

```bash
# 1) 改代码 + 改 package.json 的 version，跑闸门
node --test "test/*.test.js"
node scripts/validate-market-index.mjs

# 2) 提交，然后拿完整 sha
git log --format='%H %ct %s' -1

# 3) 把新版本写进 index.json（commit 写 40 位，publishTimestamp 用该 commit 的 %ct）

# 4) 再跑一次闸门，确认「索引最新版本 == package.json version」且 commit 存在
node scripts/validate-market-index.mjs

# 5) 推送
git push origin main
```

版本 → commit 对照（本仓库现状）：

| 版本 | commit | publishTimestamp | 内容 |
|---|---|---|---|
| 0.3.1 | `1d8a1175e879d75777fd734cdce00351faae9abe` | 1792652881 | 修入口 `ReferenceError: Config is not defined` |
| 0.3.0 | `7602106d0afc12049651821c150f6c6ec01961b1` | 1792652446 | 插件行暴露为可编辑的 settings namespace |
| 0.2.0 | `7eb09bb54df95c86b05f06ce9c53cd6f025bf96c` | 1792651132 | 记忆卫生层（去重/整理） |

---

## 5. 在 DSH 里挂上这个索引

**插件 → 发现 → 索引源**，填本文件的 raw URL：

```
https://raw.githubusercontent.com/meisijiya/dsh-hindsight-memory/main/index.json
```

- 索引源是**运行时**去拉的（宿主 `dsh-plugin-market` 拉取后按 `cacheTtlMs` 缓存，默认 10 分钟；
  拉取接口也支持 `refresh` 绕过缓存）⇒ 改完 `index.json` 推上 GitHub，等缓存过期或手动刷新索引即可生效，
  **不用重启 DSH**。
- 但如果你改的是插件**本体**（`src/`、`package.json` 的 `dsh.client` 段），
  那必须**重启 DSH Web**：宿主在启动时解析 `package.json` 并**进程内缓存**，之后改磁盘不生效。
- 装出来的版本由索引里的 `source.commit` 决定（精确到 commit），不是浮动 HEAD；
  走 `github:` 依赖安装时则是浮动的 HEAD，两条路的版本语义不一样，别混。

---

## 6. 排障速查

| 症状 | 根因 | 处理 |
|---|---|---|
| 发现页里插件整个不见了，宿主只说「索引加载失败」 | 索引里某条不合 format-1（最常见：`commit` 写了短 sha） | `node scripts/validate-market-index.mjs`，按 FAIL 项修 |
| 索引能加载，但装出来的不是想要的版本 | `source.commit` 指向旧 commit | 核对 commit 上的 `package.json` 版本（闸门第 3 层会查） |
| 改了 `index.json` 但发现页没变 | 索引源有缓存（默认 10 分钟 `cacheTtlMs`） | 等缓存过期或走 `refresh` 重新拉取；本体改动才需要重启 DSH |
| 插件卡片出现但没有「配置」按钮 | client 半体没装载（DSH 启动时缓存了 `dsh.client`） | 重启 DSH Web |
