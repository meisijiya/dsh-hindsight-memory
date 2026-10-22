---
id: "c0a19866-83b6-41f0-a1cc-6d51667d0ceb"
title: "dsh-hindsight-memory · 记忆卫生层、配置面板修复与离线验证法 r3"
description: "插件第三轮落盘：记忆卫生层（去重/合并/分层归属）、配置表单不出现的根因与修复（volatile 契约、入口 ReferenceError）、旁路验证法（不重启用户 DSH 实例）、运维红线与命令清单。"
status: "active"
created_at: "2026-10-22T07:46:52.866Z"
updated_at: "2026-10-22T07:46:52.866Z"
content_hash: "fa97580ae7fc9fb404cf000ae86b4393150de7911bfdd397700b8e760a08e7e4"
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

# dsh-hindsight-memory · r3（记忆卫生 + 配置面板修复 + 离线验证法）

仓库：https://github.com/meisijiya/dsh-hindsight-memory （main，00f78f0）
本机开发目录：`D:\26code\随便问问\dsh-hindsight-memory`
已装 profile：`C:\Users\22923\.dsh\profiles\web`（依赖 `github:meisijiya/dsh-hindsight-memory`，当前 0.3.1）

## 1. 本轮三件事

| 事 | 版本 | 落点 |
|---|---|---|
| 记忆卫生层（去重/合并/分层归属） | 0.2.0 | `src/hygiene.js`、`src/client.js` 追加 6 个 REST 方法、`memory_hygiene` 工具、`scripts/hygiene.mjs`、`scripts/panel.mjs` 卫生板块、bank 级 consolidation 配置 |
| 配置表单不出现 → 根因=字段未标 volatile | 0.3.0 | `src/schema.js` 的 `LiveConfig`、`src/index.js` 的 `unwrapConfig` + `loader/volatile-update` 热更新、`test/schema.test.js` |
| v0.3.0 引入的入口 ReferenceError | 0.3.1 | `src/index.js` 默认导出改 `Config: LiveConfig`；新增 `test/entry.test.js` |

## 2. 记忆卫生：清理能力归属（取证结论）

| 位置 | 有没有自动清理 | 证据 |
|---|---|---|
| omp | **没有** | 对 `omp.exe`（224MB）做字符串取证，只有 retain/recall/reflect 与 bank/mental-model 逻辑，无去重/清理/合并代码 |
| Hindsight 服务端 | **只有一半** | `POST /v1/default/banks/{bank}/consolidate` 合并 observation（返回 `{"deduplicated":true}`）并按 `max_observations_per_scope` 裁剪；**world 原始事实不去重** |
| bank 级配置 | **有**（已用） | `consolidation_strategies` / `observations_mission` / `max_observations_per_scope` / `enable_auto_consolidation` / `enable_observations` |
| `memory_defense` | 只是配置透传 | 本镜像里无实现类（config.py:3490/3852/5109、config_resolver.py:93）⇒ 不作依赖 |
| dsh-mnemon | 没有 | 它的 provider 只有 read/remember，无整理能力 |

结论：**清理能力必须落在共享 bank 上**，两端同时受益（DSH 插件 + omp 原生后端都吃同一份配置）。
world 事实的近重复只能由客户端整理层处理（服务端不去重）⇒ 由 `memory_hygiene` 工具承担。

### 分层归属的硬边界
- 策略 `scopes:[{tags:["project:*"],tags_match:"all"}]` 能命中项目 scope（实测命中 `['project:随便问问']`，25 observations）。
- **无标签 scope（全局层）无法被任何规则命中**（空标签 scope 与「scope 含全部规则标签」的匹配语义不相容）
  ⇒ 全局层只能靠 bank 级 `observations_mission` + `max_observations_per_scope` 兜住。

## 3. 已生效的 bank 配置（PATCH /v1/default/banks/shared/config）

- `consolidation_strategies=[{scopes:[{tags:["project:*"],tags_match:"all"}], observations_mission:"只保留该项目中长期有效的技术决策、约定、硬约束与踩过的坑；…", max_observations_per_scope:40}]`
- `observations_mission="只保留跨项目长期有效的约定、环境事实与用户偏好；…"`
- `max_observations_per_scope=30`
- `enable_auto_consolidation=true`、`enable_observations=true`
（PATCH 前：consolidation_strategies=null、observations_mission=null、max_observations_per_scope=-1）

## 4. 记忆卫生实测

- `node scripts/hygiene.mjs --threshold 0.8 --apply` → 作废 6 条、失败 0（可逆：`state:"invalidated"`，可用 `state:"valid"` 还原）。
- 随后 `POST /consolidate` → `{"operation_id":"f0720773-…","deduplicated":true}`，活跃 87→81→88（服务端重建 observation）。
- 类型感知分组（默认只比 world，observation 视为服务端归纳层不参与）后，阈值 0.8/0.7 重复组均为 0。
- `recall(project:随便问问)` 命中 14 条、近重复组 0（清理前召回块里有 4 条近义重复）。
- `node scripts/verify-live.mjs` → 8/8 通过（含「别项目标签硬隔离负例 count=0」）。
- 保留项：world 与 observation 同文的「双胞胎」语义不同，**不删**。

## 5. 配置表单不出现的根因（宿主两道门）

1. **client 槽位**：`plugins.row.config`（键=`<包名>#<行 id>` = `dsh-hindsight-memory#hindsight-memory`）必须有 occupant；
   渲染点 `dsh-client-ui-plugin-manager/lib/client.js:2818`；`formFor(id)` 在 `configurations` 里找不到 ns 就返回 undefined（:3833）。
2. **settings 描述符**：`dsh-settings/lib/index.js:413 describe()` 遍历 configEditor 条目，
   `volatileForm(schema)` **只保留 volatile 字段**（:122-131），非 volatile 整段裁掉；再要求 `entry.fiber.state === 2`（插件在跑）。
   `schema(entry) = entry.fiber.runtime.Config`（:538-541）⇒ 插件必须导出带 volatile 的 Config。

⇒ v0.2.0 的 Config 是普通 schema → 描述符从未产生 → 页面只能显示「settings namespace 未就绪」。
**报错文案指向的不是真正堵点。** 样板：`dsh-mnemon` 的 `LiveConfig`（`new z(Config.toJSON())` 后逐字段 `.volatile()`，只留 `remoteAccess` 不动）+ 监听 `loader/volatile-update`（:17711）。

## 6. v0.3.1：静默整行失效（离线复现）

旁路启动 `dsh --profile web --patch <overlay>.yml --port 3081 web` 的日志：

```
dsh: warning: 1 entry did not activate
hindsight-memory (dsh-hindsight-memory): failed to import:
  ReferenceError: Config is not defined
  at .../src/index.js:616:32
```

根因：`export { LiveConfig as Config }` 是**再导出**，模块作用域里没有 `Config` 绑定，
默认导出 `export default { name, inject, Config, apply }` 引用未定义标识符 ⇒ 模块求值即抛 ⇒ 整行插件加载失败（宿主只给 warning）。
教训：①再导出 ≠ 绑定；②单测必须 `import("../src/index.js")`，否则这类 bug 必漏（已加 `test/entry.test.js`）；③静默失败按"行"查日志。

## 7. 旁路验证法（不重启用户实例）

| 目的 | 手段 | 备注 |
|---|---|---|
| 查插件在宿主的真实加载 | `dsh headless --patch <overlay>.yml "…"` + 一次性探针插件打印 `ctx.settings.describe()` | headless 是**独立 profile**，不含 web profile 的插件行 ⇒ 看不到 `hindsight-memory` 属预期 |
| 查 schema 契约 | profile 目录内 `node --input-type=module -e "import('.../src/schema.js')"` | 读 dict/meta，不依赖宿主进程 |
| 查 web profile 的加载 | `dsh --profile web --patch <overlay>.yml --port <空闲端口> web` | 会与用户实例争端口；本机 3080/3081 同属用户进程 PID 41108 ⇒ **不可乱杀** |

## 8. 用户实例安全红线

`netstat`：PID 41108（`dsh lib/bin.js web --no-open`）同时监听 `127.0.0.1:3080` 与 `0.0.0.0:3081`，
它承载当前会话与公网隧道（dsh-pocket）。**任何重启/杀进程都可能把会话带走** ⇒
插件验证一律旁路进行；需要用户重启时，明确告知并由用户自己操作。

## 9. 运维清单

```bash
# 升级（git 依赖不会自动更新）
cd /c/Users/22923/.dsh/profiles/web && pnpm update dsh-hindsight-memory --latest

# 单测（Windows 不能写 node --test test/）
cd /d/26code/随便问问/dsh-hindsight-memory && node --test "test/*.test.js"   # 33 条

# 活体自检
node scripts/verify-live.mjs          # 8 项
node scripts/panel.mjs --dir "D:/26code/随便问问"
node scripts/hygiene.mjs --threshold 0.8            # 预览
node scripts/hygiene.mjs --threshold 0.8 --apply    # 作废（可逆）
node scripts/isolation-check.mjs --a <项目A> --b <项目B>
```

## 10. 遗留 / 风险

- **autoRetain=true ⇒ 每轮都落一条项目层事实**：本轮库从 88 长到 101（含自检探针与自动留存）；需定期 `hygiene.mjs` 收。
- 插件的「配置表单」要等**用户重启一次 DSH Web** 才出现（client 图在启动时 resolveMeta 决定，磁盘改动不触发重算）。
- DSH 侧纯全局层读取仍需「整库读 + 客户端过滤」（服务端无「只取无标签」表达）。
- omp 侧仍产不出全局层（retain 恒带 `project:` 标签）⇒ 全局层只由 DSH 侧无标签写入产生。
