---
id: "b6db8704-5f6e-49e1-8e03-0f48fdfe1456"
title: "dsh-hindsight-memory · v0.4.0 发布、tarball 资产与插件市场投稿"
description: "插件市场投稿的完整落地记录：条目格式、1 天仓库年龄门禁与 regate 自动复检、Release/tarball 资产、peerDependencies 决策、PR #8696，以及本地索引与推荐库的同步更新。"
status: "active"
created_at: "2026-10-22T11:28:33.064Z"
updated_at: "2026-10-22T11:28:33.064Z"
content_hash: "94cc46187746e17b651bd25b7a798fa5e18ed42227d06829bab61ea5c126d78c"
source_paths:
  - "dsh-hindsight-memory/package.json"
  - "dsh-hindsight-memory/index.json"
  - "dsh-hindsight-memory/README.md"
  - "dsh-hindsight-memory/docs/design.md"
  - "dsh-plugin-recommendations/plugins.json"
session_ids:
  - "session-43883589-ddc1-421b-b98b-e8eb4ba66b78"
memory_body_ids:
  []
---

# dsh-hindsight-memory · v0.4.0 发布与插件市场投稿（2026-10-22）

## 一、背景与目标

用户 m04051：「我已手动删除（omp-memory-dsh 仓库），可以把插件推送到插件市场 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md」。

目标：把 `meisijiya/dsh-hindsight-memory` 按 awesome-dsh-plugin 的投稿规范提交到插件市场，并把安装路径补成「git 源码 + Release tarball」双通道。

## 二、投稿规范要点（contributing.md，实读）

- 投稿 = **只加一个文件** `data/plugins/<owner>__<repo>.yml`；README.md / README.zh.md 由 `scripts/generate-readme.mjs` 生成，**不要手改**。
- 字段：`url`（必须与仓库完全一致）、`name`（`owner/repo`）、`category`（memory 属于可用值）、可选 `tarball`、`description.en` 必填、`description.zh` 可选。
- 描述含 `": "` 必须加引号，否则 YAML 解析成嵌套键。
- 硬性要求：仓库 package.json 声明 `dsh.bundle`（只声明 `dsh.client` 会被 CI 拒）；仓库有真实可用代码；**仓库创建满 1 天**（CI 自动检查）；仓库带 `dsh-plugin` topic；一个 PR 最多 3 条。
- 官方 `@deepseek-ai/*` 包建议用 peerDependencies，peer 范围要带显式预发布分支（如 `">=0.2.1-rc.1 <0.3.0-0"`）。

## 三、本轮实际动作与证据

1. **补 peerDependencies（optional）**：package.json 新增 peerDependencies `@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-app-boot >=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`、`@deepseek-ai/dsh-typert-protocol` 同上、`react ^18.2.0`、`react-dom ^18.2.0`，全部标 `peerDependenciesMeta.optional=true`（宿主提供，pnpm 不会因未满足 peer 而失败）。`@deepseek-ai/schemastery` 保留在 dependencies——本地第一方插件 dsh-mnemon / dsh-mnemon-source-memory-spaces 也是这么写的，且 src/schema.js 需要动态 import 它（缺失时优雅退化为无表单）。
   - 提交 `0b442b0`，57/57 单测通过，`node scripts/validate-market-index.mjs` 17/17 PASS。
2. **Release + tarball**：`npm pack` → `dsh-hindsight-memory-0.4.0.tgz`（94,523 字节，23 个文件，含 cordis.patch.yml / package.json / src/index.js / src/ui-client.js / README / LICENSE）；`gh release create v0.4.0 <tgz>` → https://github.com/meisijiya/dsh-hindsight-memory/releases/tag/v0.4.0
3. **仓库 topic**：`gh repo edit --add-topic dsh-plugin` → topics = ["dsh-plugin"]。
4. **市场条目**：`data/plugins/meisijiya__dsh-hindsight-memory.yml`
   ```yaml
   url: https://github.com/meisijiya/dsh-hindsight-memory
   name: meisijiya/dsh-hindsight-memory
   category: memory
   tarball: https://github.com/meisijiya/dsh-hindsight-memory/releases/download/v0.4.0/dsh-hindsight-memory-0.4.0.tgz
   description:
     en: 'Bridges DeepSeek Harness to a Hindsight memory service using the same conventions as omp: one shared bank, automatic project-tag stamping, project plus global recall, plus tools for mental models, duplicate detection and retrying failed background operations. Requires a running Hindsight server (default http://127.0.0.1:8888).'
     zh: '把 DeepSeek Harness 接入 Hindsight 记忆服务，沿用与 omp 相同的约定：单一共享 bank、自动打项目标签、项目层与全局层同时召回，并提供精神模型、重复检测与失败后台任务重试工具。需要本机已运行 Hindsight 服务（默认 http://127.0.0.1:8888）。'
   ```
5. **生成 README**：fork 内 `npm ci` + `node scripts/generate-readme.mjs` → README.md / README.zh.md 各只加 1 行（6379 entries），无连带改动；提交 `8573b50` 推到 fork 分支 `feat/add-dsh-hindsight-memory`。
6. **开 PR**：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8696 （OPEN / MERGEABLE，2026-10-22T11:25:41Z）。
7. **本地索引与推荐库同步**：
   - `dsh-hindsight-memory/index.json`：0.4.0 的 `source.commit` 改为发布提交 `0b442b0d3b0a4a7c58ea158eb56de99569175b18`，`publishTimestamp` = 1792667833（2026-10-22T11:17:13Z）；自检 17/17 PASS；提交 `b5c005b` 已 push（`--force-with-lease`，因 amend 过时间戳）。
   - `dsh-plugin-recommendations/plugins.json`：omp-memory-dsh 的 retiredNote 补记「由用户手动删除」；提交 `0ced2d9` 已 push。

## 四、仓库年龄门禁与 regate 自动复检（关键结论）

- 本仓库 `createdAt = 2026-10-22T04:42:46Z`（今天），**不满 1 天** → 首轮 `PR check` 的年龄判定会红。
- 但市场仓库自带 `.github/workflows/regate.yml`（`Re-check gated submissions`）：注释写明「a PR blocked at '0.5 days old' qualifies a few hours later, but nothing re-runs the check, so it sits red until someone pushes」→ 该 workflow 每 6 小时（`cron: '19 */6 * * *'`）自动复检开着的 PR，**仓库满 1 天（2026-10-23T04:42:46Z ≈ 北京时间 12:42）后会自动转绿，无需重新提交**。
- 所以选择「现在开 PR、让 regate 自动放行」，而不是压着不发。

## 五、安装方式（对外）

```bash
# 源码
dsh plugin --profile web add "git+https://github.com/meisijiya/dsh-hindsight-memory.git"
# tarball
dsh plugin --profile web add ./dsh-hindsight-memory-0.4.0.tgz
```
需要本机运行 Hindsight 服务（默认 http://127.0.0.1:8888），插件配置项：服务地址、bank、分层策略、召回预算、记忆卫生阈值、精神模型开关等。

## 六、已知限制 / 后续

- DSH 侧的读路径比 omp 宽：dsh-mnemon 的 provider 不支持 tag 过滤（v0.5.6 已是最新），DSH 的项目级隔离靠 `mcp__hindsight__recall` 显式传标签实现。
- DSH 不写 bank 的 mission（避免与 omp 互相覆写），使命文案由服务端 bank 配置持有。
- 若市场 CI 除年龄外还有别的红项，改条目 yml 或描述文案后重新 push 同一分支即可触发复检。
