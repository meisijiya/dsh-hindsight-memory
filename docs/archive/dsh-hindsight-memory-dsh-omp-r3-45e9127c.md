---
id: "45e9127c-5910-440e-921f-f790662a6026"
title: "dsh-hindsight-memory · 隔离分层实测矩阵（DSH 侧 + omp 侧）r3"
description: "两项目目录下的隔离可见性实测结果：DSH 插件侧 6 格矩阵 + 真实 omp 客户端注入块复核 + 整库分层计数 + 复现命令"
status: "active"
created_at: "2026-10-22T06:04:39.390Z"
updated_at: "2026-10-22T06:04:39.390Z"
content_hash: "d26456860517efba2153e743c755785404b00f27d4606b01924713ffd8d9cb25"
source_paths:
  - "dsh-hindsight-memory/scripts/isolation-check.mjs"
  - "dsh-hindsight-memory/scripts/panel.mjs"
  - "dsh-hindsight-memory/docs/design.md"
  - "dsh-hindsight-memory/README.md"
session_ids:
  - "session-43883589-ddc1-421b-b98b-e8eb4ba66b78"
memory_body_ids:
  []
---

# dsh-hindsight-memory · 隔离分层实测矩阵 r3

日期：2026-10-22
插件仓库：https://github.com/meisijiya/dsh-hindsight-memory
本地路径：`D:\26code\随便问问\dsh-hindsight-memory`
测试目录：`D:\26code\随便问问`（项目A，label=`随便问问`）与 `D:\26code\测试hindsight`（项目B，label=`测试hindsight`，已 git init）

## 一句话结论

**项目隔离靠标签，不靠库名**：同一块 `shared` 库里，`project:<仓库名小写>` = 项目层（互不可见），
「无 tag」= 全局层（处处可见）。DSH 与 omp 读写同一批数据、各自只看自己该看的那一层——**两端行为已实测对齐**。

## 一、DSH 插件侧矩阵（`node scripts/isolation-check.mjs`，走插件自己的 client）

| 观察者 | scope | A 层 | B 层 | 全局层 |
| --- | --- | :---: | :---: | :---: |
| 项目A（随便问问） | project（项目层+全局层） | ✅ 可见 | ❌ 不可见 | ✅ 可见 |
| 项目A | project_only（仅项目层） | ✅ 可见 | ❌ 不可见 | ❌ 不可见 |
| 项目A | global（仅全局层） | ❌ 不可见 | ❌ 不可见 | ✅ 可见 |
| 项目B（测试hindsight） | project（项目层+全局层） | ❌ 不可见 | ✅ 可见 | ✅ 可见 |
| 项目B | project_only（仅项目层） | ❌ 不可见 | ✅ 可见 | ❌ 不可见 |
| 项目B | global（仅全局层） | ❌ 不可见 | ❌ 不可见 | ✅ 可见 |

写侧盖章实测：tier=project → 落库 `["project:随便问问"]`；tier=global → 落库 `[]`。

## 二、真实 omp 客户端侧（读 omp 会话文件里注入的 `<memories>` 块，不采信模型自述）

| omp 运行目录 | 注入条数 | 看到 | 看不到 |
| --- | --- | --- | --- |
| `D:\26code\测试hindsight` | 16 | 项目B 层 + 全局层 | 项目A 层 |
| `D:\26code\随便问问` | 17 | 项目A 层 + 全局层 | 项目B 层 |

omp 日志印证自动盖章：`Hindsight: seeded mental model ... tags:["project:测试hindsight"]`。
（`HINDSIGHT_DEBUG=1` 的 `matchedUntagged/matchedTagged` 计数可作二次核验。）

## 三、整库分层计数（87 条活跃事实，探针已作废）

| 视角 | 全局层（无 tag） | 本项目层 | 其它项目层 |
| --- | --- | --- | --- |
| 随便问问 | 29 | 58 | 0 |
| 测试hindsight | 29 | 0 | 58 |

## 四、复现命令

```bash
node scripts/isolation-check.mjs --a "D:/26code/随便问问" --b "D:/26code/测试hindsight"
node scripts/panel.mjs --dir "D:/26code/随便问问"
node scripts/panel.mjs --dir "D:/26code/测试hindsight"
```

脚本行为：写三条探针（项目A / 项目B / 全局层）→ 轮询 `/memories/list` 等抽取完成 → 打 6 格可见性矩阵
→ 整库标签分布 → 观测完自动 PATCH invalidated（`--keep` 可保留）。

## 五、诚实账（副产品）

- Hindsight 的 retain **不去重**：同一事实写多次 = 多条 fact；当前库「双层标签」相关 2 条、「GLOBAL-LAYER」相关 2 条。
- omp 的 auto-retain 每 3 回合一次，**任何会话文本**都会入库（实测 `omp -p "ISOCHECK 探针事实"` 也被写成项目层事实）。
  长期需要「同一事实合并 + 定期清理」策略（服务端无 dedup 端点，只能客户端比对后 invalidate）。
- 纯全局层读取在服务端没有表达方式，只能「整库读 + 客户端过滤」（`recallFilter` 的 clientFilter=untagged）。

## 六、关联

- 设计文档：`dsh-hindsight-memory/docs/design.md` §11（omp 契约基线）、§21（本次实测）
- README：`dsh-hindsight-memory/README.md`「隔离分层观测（怎么验证『隔离真的按预期分层』）」
- 相关文档 id：fc80fc27-c0d3-4d42-baeb-858401a3c5c1（设计 r1）、94e066ee-dbef-41da-9556-c1b9c08c3304（安装/面板 r2）、31b80672-40e9-43f6-99b5-5881819fd12b（单 bank 双层标签落地手册）
