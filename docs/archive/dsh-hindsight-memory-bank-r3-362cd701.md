---
id: "362cd701-c3be-4cce-a494-17b7012bce96"
title: "dsh-hindsight-memory · 记忆卫生层（共享 bank 去重 + 服务端自动整理）r3"
description: "记忆卫生能力归属取证（omp 无清理 / 服务端只整理 observation / world 需客户端去重）、三层护栏、bank 级配置已 PATCH 的键与值、插件 v0.2.0 新增的 memory_hygiene 工具与 hygiene.mjs 脚本、实测数据与已知限制。"
status: "active"
created_at: "2026-10-22T06:39:52.541Z"
updated_at: "2026-10-22T06:39:52.541Z"
content_hash: "9ce6778bbbdb3436853c6f29ecaf0fa477f6768b71437c38c0ae2f975d986612"
source_paths:
  - "dsh-hindsight-memory/src/hygiene.js"
  - "dsh-hindsight-memory/src/client.js"
  - "dsh-hindsight-memory/src/index.js"
  - "dsh-hindsight-memory/scripts/hygiene.mjs"
  - "dsh-hindsight-memory/scripts/panel.mjs"
  - "dsh-hindsight-memory/docs/design.md"
  - "dsh-hindsight-memory/README.md"
session_ids:
  - "session-43883589-ddc1-421b-b98b-e8eb4ba66b78"
memory_body_ids:
  []
---

# 记忆卫生层（共享 bank 去重 + 服务端自动整理）· r3

> 触发：用户 m03038「omp 没有自动清理吗？可以推下一轮。总之，DSH 和 omp 两侧读写一致，避免记忆行为分裂。」
> 落点：`D:\26code\随便问问\dsh-hindsight-memory`（v0.2.0，commit `7eb09bb` + `5b4b703`）

## 1. 能力归属取证（结论先行）

| 组件 | 有无清理能力 | 证据 |
|---|---|---|
| **omp** | ❌ 无 | 对 `omp.exe` 做字符串取证：只有 retain/recall/reflect + bank/mental-model 逻辑，**无去重/清理/合并代码**；Hindsight API 也无 world 去重端点 |
| **Hindsight 服务端** | ⚠️ 只有一半 | `POST /v1/default/banks/{bank}/consolidate` 合并 observation（实测返回 `{"deduplicated": true}`），并按 `max_observations_per_scope` 裁剪；**world 原始事实不去重** |
| **bank 级配置** | ✅ 有 | `consolidation_strategies`、`observations_mission`、`max_observations_per_scope`、`enable_auto_consolidation`（BankTemplateConfig 51 键中与整理相关的部分） |
| **dsh-mnemon** | ❌ 无 | provider 0.5.6 无清理接口 |

**决策**：清理必须落在**共享 bank 层**——DSH 与 omp 读写同一个 bank，整理在 bank 上做两端同时受益；放在某一侧做 = 行为分裂（用户明确不接受）。

## 2. 分层归属

| 层 | 归属 | 机制 |
|---|---|---|
| L1 服务端自动 | Hindsight 本体 | 项目层 scope 用 `consolidation_strategies`（口径 + 上限 40）；全局层用 bank 级 `observations_mission` + `max_observations_per_scope=30`；`enable_auto_consolidation=true` |
| L2 客户端整理 | 插件 `memory_hygiene` + `scripts/hygiene.mjs` | world 原始事实近重复清理（服务端无此能力） |

## 3. 去重三条护栏

1. **同层才比**：分组签名 = `fact_type + 标签集`；项目层与全局层语义不同，同文也不同义。
2. **不动 observation**：服务端每次 retain 同时产出 world 原文与 observation 归纳，文本相似但语义不同；默认跳过（`includeObservations=false`）。
3. **每组留最新 + 可逆**：保留 `updated_at` 最新一条，其余 `PATCH state=invalidated`；服务端 `invalidated ⇄ valid` 可逆。

算法：中文按字符二元组 + 拉丁按词切分取 Jaccard；阈值 0.9 = 逐字级，0.8 = 换说法级。

## 4. 已落地的 bank 配置（PATCH 生效）

```json
{
  "consolidation_strategies": [{
    "scopes": [{ "tags": ["project:*"], "tags_match": "all" }],
    "observations_mission": "只保留该项目中长期有效的技术决策、约定、硬约束与踩过的坑；不保留一次性进度、临时状态与重复表述。",
    "max_observations_per_scope": 40
  }],
  "observations_mission": "只保留跨项目长期有效的约定、环境事实与用户偏好；不保留一次性进度、临时状态与重复表述。",
  "max_observations_per_scope": 30,
  "enable_auto_consolidation": true,
  "enable_observations": true
}
```
原值：consolidation_strategies=null、observations_mission=null、max_observations_per_scope=-1。

## 5. 插件 v0.2.0 新增

- `src/hygiene.js`：纯函数（normalizeForCompare / tokenize / similarity / tagSignature / factType / dupSignature / findDuplicateGroups / planPrune / summarizeGroups），默认跳过 observation。
- `src/client.js`：listFacts / setFactState / consolidate / observationScopes / previewStrategies / bankConfig / patchJson（MCP 工具面仍收窄在 7 个安全工具内）。
- 第 5 个工具 `memory_hygiene`：action = preview | prune | consolidate | scopes | strategies-preview；prune 默认 dryRun=true。
- 6 个新配置：hygieneThreshold(0.9) / hygieneMaxFacts(500) / hygieneProjectMission / hygieneProjectMaxObservations(40) / hygieneGlobalMission / hygieneGlobalMaxObservations(30)，并镜像进浏览器配置面板「记忆卫生」分组。
- `scripts/hygiene.mjs`（CLI，默认只读预览）、`scripts/panel.mjs` 追加「记忆卫生」板块。
- 单测 28/28 通过（新增 10 条）。

## 6. 实测（2026-10-22）

- 清理前 93 条活跃事实，召回块里有 4 条近义「双层标签」重复。
- `node scripts/hygiene.mjs --threshold 0.8 --apply` → 作废 6 条、失败 0；`POST /consolidate` 返回 `deduplicated:true`，活跃 81 → 88（服务端重建 observation）。
- 类型感知分组后阈值 0.8/0.7 重复组均为 0；剩余「9999 UI」双事实是 world/observation 双胞胎，判定不该删。
- `recall(project:随便问问)` 命中 14 条、近重复组 0。
- `node scripts/verify-live.mjs` 8/8 通过（含「别项目标签硬隔离负例 count=0」）。
- `node scripts/panel.mjs --dir "D:/26code/随便问问"` → 全局层 22 / 项目层 66 / 其它项目层 0 / 合计 88；observation scope `project:随便问问 29 条` + `(全局层) 10 条`。
- profile 已更新到 0.2.0（`pnpm update dsh-hindsight-memory --latest`），**需重启 DSH Web 生效新工具**。

## 7. 已知限制

- world 去重只能客户端做 ⇒ 需定期跑脚本/工具，不是自动发生的。
- 全局层（无标签 scope）**无法被任何 consolidation_strategies 规则命中**（匹配语义 = scope 含全部规则标签，空标签 scope 谁都匹配不上）⇒ 只能靠 bank 级 observations_mission + max_observations_per_scope 兜。
- `memory_defense` 在本镜像只是配置透传，无实现，不作为依赖。
- 探针脚本 `scripts/_*.mjs` 一次性用完已删；`scripts/hygiene.mjs` 保留为正式入口。
