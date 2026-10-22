---
id: "6e05a7b7-6b9f-4824-b9a2-2c51b0037de9"
title: "dsh-hindsight-memory · 对齐 omp 接入报告（精神模型 + 运维观测 + 分层维护）r4"
description: "插件 v0.4.0：对齐用户提供的 omp 接入报告——补齐精神模型层（memory_mental_models，中文项目名 id 不退化）、运维观测（memory_operations + memory_status 队列体检）、分层维护工具（memory_hygiene scope/layers）、写入元数据（timestamp + session_id）、留存节奏对齐 omp；含差距对照表 G1–G10、三个服务端硬事实、实测数据与已知限制。"
status: "active"
created_at: "2026-10-22T09:03:42.081Z"
updated_at: "2026-10-22T09:03:42.081Z"
content_hash: "b3b282449cbebe1a5d93bec02bc5dbe85bb96ed69820b88074b5e98022b3bfd0"
source_paths:
  - "dsh-hindsight-memory/src"
  - "dsh-hindsight-memory/scripts"
  - "dsh-hindsight-memory/test"
  - "dsh-hindsight-memory/docs/design.md"
  - "dsh-hindsight-memory/README.md"
  - "dsh-hindsight-memory/cordis.patch.yml"
session_ids:
  - "session-43883589-ddc1-421b-b98b-e8eb4ba66b78"
memory_body_ids:
  []
---

# dsh-hindsight-memory · r4（对齐 omp 接入报告：精神模型 + 运维观测 + 分层维护）

仓库：https://github.com/meisijiya/dsh-hindsight-memory （main）
本机开发目录：`D:\26code\随便问问\dsh-hindsight-memory`
已装 profile：`C:\Users\22923\.dsh\profiles\web`（依赖 `github:meisijiya/dsh-hindsight-memory`，已升级到 **0.4.0**）

> 触发：用户 m03484「D:\26code\随便问问\omp-hindsight-report.md 这个是 omp 测的报告，可以看看，然后看看 DSH 侧的插件需不需要做什么优化。我看项目级记忆靠 tag 召回，全局级记忆无需 tag，因此我们 DSH 对于项目级和全局级的维护工具要封装好」。

## 1. 差距 → 落点（G1–G10 全部收敛）

| 差距 | 内容 | 落点 | 状态 |
|---|---|---|---|
| G1 | **精神模型层完全缺失**（omp 启动建 user-preferences / project-conventions / project-decisions） | `src/mental-models.js` + `memory_mental_models` 工具 + 会话内自动 ensure/注入 | ✅ |
| G2 | 分层维护工具不完整（hygiene 无 scope、status 只有粗计数） | `memory_hygiene` 增 `scope`（all/project/global/other）与 `action=layers`；`memory_status` 增 `layerDetail`（条数+类型分布+最近更新） | ✅ |
| G3 | 运维观测缺失（失败任务不自动重试却看不见） | `memory_operations`（list/retry/delete）；`memory_status.operations` 队列体检 | ✅ |
| G4 | mission 归属：DSH 不得改写共享 bank 的 mission | 代码层锁死不实现 `PUT /banks`，并加静态回归测试 | ✅ |
| G5 | mental model id 唯一性（中文名 + 前缀） | id = `dsh-<片段>-<完整项目名>`，不 ASCII 过滤，与 omp id 空间分离 | ✅ |
| G6 | bank fact_count 核对 + 空 bank 警告 | `client.bankOverview()` + `memory_status.bank.warnings` | ✅ |
| G7 | recall 只发 omp 的 6 个字段 | 已对齐，**新增回归测试锁死**（不发 prefer_observations / filter） | ✅ |
| G8 | retain 缺 `timestamp` + `metadata.session_id` | `localTimestamp()`（本地时区带偏移）+ `metadata.session_id`（REST 与 MCP 双路径） | ✅ |
| G9 | 不实现 memory_edit 类原地编辑 | 保持不实现（纠错靠新写入 + observation 滚动淘汰） | ✅ |
| G10 | 自动留存节奏不一致（DSH 每轮写、omp 每 3 轮） | 复用既有配置键 `retainEveryNTurns`（默认 3），index.js 真正启用 | ✅ |

## 2. 三个必须记住的服务端硬事实

1. **mental model 的 `max_tokens` 必须 ≥ 256**，否则 422 `greater_than_equal`（配置下限已从 100 提到 256）。
2. **`POST /mental-models` 是仅创建**：重复 id 返 409，**不改写已有 tags**；改标签只能 PATCH。
   插件 `planEnsure()` 因此是三分支：缺→create、标签不符→patch、对的→keep。
3. **list 响应键是 `items`**（mental models 与 operations 都是 `{items|operations,total,limit,offset}`）。

## 3. 中文项目名在 omp 侧的坑（对照实验）

omp 的 mental model id 规则是「只保留 ASCII 字母数字」⇒ 纯中文项目名全部退化成
`project-conventions-project`，多个中文项目抢同一个模型；本机实测该模型带着 `project:随便问问` 的标签。
服务端**不强制** id 只能 ASCII（实测中文 id 创建 200），
故 DSH 侧用 `dsh-` 前缀 + 完整中文项目名，DSH 与 omp 的模型互不覆盖。

## 4. 活体验收（旁路 headless，未重启用户实例）

`dsh headless --patch <overlay>.yml "…"`（overlay 用 file:// 指向本地 src）实测：

- `memory_mental_models action=ensure` → `created:0 patched:0 kept:3`
  （`dsh-user-preferences` tags=[]、`dsh-project-conventions-随便问问` tags=["project:随便问问"]、`dsh-project-decisions-随便问问` 同）。
- `memory_hygiene action=layers` → 全局层 23（world 13 / observation 10）、项目层 137（world 64 / observation 40 / experience 33）、其它项目层 19、合计 179。
- `memory_status` → `bank.factCount=179, totalBanks=1, warnings=[]`；`operations` → total 248 / processing 8 / completed 11 / failed 1（含 error 与 retryCount）。
- 单测 **57/57**；`node scripts/verify-live.mjs` **8/8**（含跨项目硬隔离负例 count=0）。
- profile 侧安装态冒烟：0.4.0 注册 7 个工具（memory_recall / memory_retain / memory_reflect / memory_status / memory_hygiene / memory_mental_models / memory_operations），Config 34 键。

## 5. 由这轮数据引出的判断

项目层 137 条 vs 全局层 23 条——项目层被自动留存灌满（每轮写一条原始事实，服务端再抽取成多条）。
已按 omp 的 `retainEveryNTurns=3` 限流；且 bank 级 `max_observations_per_scope=30` 只兜 observation，
**world 原始事实不受服务端上限约束** ⇒ 长期仍需 `memory_hygiene` 的近重复清理兜底。

## 6. 已知限制（诚实账）

- 召回注入载体是 DSH 用户消息，omp 是 `<memories>` 背景块——形状对齐、载体不同。
- 自动召回不落 session 文件，resume 会重查一次（omp 重放缓存块）。
- 精神模型：DSH 与 omp 各建各的（id 前缀不同、互不覆盖），**DSH 不会去改 omp 建的模型**。
- mental model 刷新要跑完须同时放宽服务端三超时（`REFLECT_WALL_TIMEOUT` / `LLM_TIMEOUT` / worker 存活），客户端改不了（本机已放宽到 1800/600/600）。
- 失败任务**不会自动重试**，必须用 `memory_operations(action=retry)` 手动推。

## 7. 运维

```bash
# 升级 profile 里的插件（git 依赖不会自动更新）
cd /c/Users/22923/.dsh/profiles/web && pnpm update dsh-hindsight-memory --latest

# 插件自带闸门
cd /d/26code/随便问问/dsh-hindsight-memory
node --test "test/*.test.js"            # 57 个单测
node scripts/validate-market-index.mjs  # 市场索引 17 项闸门
node scripts/verify-live.mjs            # 活体 8 项（需 Hindsight 在跑）
```

> 装好新版本后需要**重启 DSH Web** 才会装载新代码与 client 半体；不要在承载当前会话的实例上重启，用 `dsh headless --patch` 旁路验证。
