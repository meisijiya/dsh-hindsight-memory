# 本地 Mnemon 层归档报告（2026-10-22）

来源：`C:\Users\22923\.mnemon\`（记忆系统 dsh-mnemon 已整体停用；数据一个字节未删，可随时回滚）
目标：把「耐久事实」搬进 Hindsight（跨 agent 共享），把「宿主机制知识」搬进仓库文档，其余留在归档里人工确认。

## 一、运行时记忆（11 条）分流

| 分流 | 条数 | 去处 | 判据 |
| --- | --- | --- | --- |
| fact | 5 | Hindsight `bank=shared` 全局层（无 tag，跨项目有效） | 是耐久事实、跨项目成立 |
| host | 4 | `docs/host-notes.md`（仓库，随代码走版本控制） | 讲的是「宿主平台怎么用」，不是项目事实 |
| skip | 2 | 仅本报告记录，等人工确认 | 会过期（会话 PID）或属于其它仓库（LayerFS） |

迁移的 5 条 fact：
1. DSH↔omp 记忆终态（共用同一 Hindsight 容器 127.0.0.1:8888，bank=shared）
2. Hindsight 双层标签方案的实测坑
3. Hindsight 双层标签真值表
4. Hindsight bank id 含中文的坑（必须 percent-encode）
5. omp-memory-dsh 插件已成死桥（改用 Hindsight 原生后端后其读路径恒为空）

写入方式：`POST /v1/default/banks/shared/memories`，body `{"items":[{"content":...,"context":"migrated from local mnemon runtime memory"}],"async":true}`
（无 tag ⇒ 全局层；服务端异步抽取，约 30s 后可召回）。
写入前已按归一化文本查重：5 条均未在库。

## 二、本地项目档案（10 篇）→ 仓库 `docs/archive/`

**决策：不建知识页。**
知识页是服务端从 bank 事实反推出来的摘要；把这 9 篇**已被取代的历史版本**（bank 级隔离、r2/r3/r4 落地手册）反推进知识页，等于把旧账写进记忆，正好制造用户担心的「认知错位」。

处理方式：
- 原件一字不改拷进 `docs/archive/`（Git 版本控制，可查可追责）；
- `~/.mnemon/documents/active/` 原件保留不动；
- 当前态的权威描述在 `docs/design.md`（第 27 章起为最新），知识页只保留「当前终态」那一张。

其中 `layerfs-dsh-windows-wsl2-a51cd322.md` 属于另一个仓库（LayerFS），只拷贝存档、不建页、不入库。

## 三、可逆性

- 全部写入都是追加型：事实用 `PATCH /memories/{id} {"state":"invalidated"}` 即可软退役（服务端无 DELETE 端点，退役可改回 `valid`）。
- 5 条迁移事实的 context 统一为 `migrated from local mnemon runtime memory`，便于日后按 context 批量回滚。
- `~/.mnemon` 目录未被修改；重新启用记忆系统即可回到旧状态。
