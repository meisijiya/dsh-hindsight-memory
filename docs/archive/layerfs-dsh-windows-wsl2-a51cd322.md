---
id: "a51cd322-35b1-4d2c-9670-f0da27c7e067"
title: "LayerFS × DSH 集成配置记录（Windows + WSL2）"
description: "本机 dsh web profile 接入 LayerFS(dsh-layerfs) 的完整配置：WSL 自有 Docker 引擎、sealed Linux bundle、runtime 镜像、profile 补丁与安装变通、重启与验证方法"
status: "active"
created_at: "2026-10-22T12:18:26.619Z"
updated_at: "2026-10-22T12:18:26.619Z"
content_hash: "cfb4727289f98f672097b46b21ecfc72ffccf413f048bdafb85828116646ce43"
source_paths:
  []
session_ids:
  - "session-60c1e73c-bd5b-4cdb-8901-c0c9ba000646"
memory_body_ids:
  []
---

# LayerFS × DSH 集成配置记录（Windows 11 + WSL2 Ubuntu-24.04）

## 目标
让本机 dsh web（profile `web`）加载 LayerFS 插件 `dsh-layerfs`：`GET /layerfs/status` 返回 `configured: true`、`missing: []`，且 LayerFS 的 Windows 适配器在 WSL2 内通过自有 Docker Engine + FUSE 跑通。

## 组件与路径
| 组件 | 值 |
| --- | --- |
| LayerFS 源码（Windows 克隆） | `D:\26code\layerfs`（HEAD 2e5061798d235819be45ef655e37ffa2799376d0） |
| LayerFS 源码（WSL 克隆，ext4） | `/root/layerfs` |
| dsh 源码（仅用于构建 client bundle） | `D:\26code\deepseek-harness`（tag dsh-v0.2.1-rc.2） |
| dsh 安装（全局 CLI + 运行库） | `D:\dev\npm\node_global\node_modules\@deepseek-ai\dsh`（0.2.1-rc.2） |
| DSH_HOME | `C:\Users\22923\.dsh`，profile `web` |
| runtime 镜像 | `layerfs-352-runtime:node24`，image ID `sha256:46f55c587ed75ebc62ede1d993fc4f542002b91e191778c20e296153702e6fa9`（**WSL 引擎内**） |
| sealed Linux bundle | `/root/.cache/layerfs-worktrees/layerfs-e9bb5836ed65/artifacts/build-linux-3ac532d8ed4d4711801212c94205d4a8` |
| WSL 自有 Docker 引擎 | docker-ce 29.9.2，socket `/run/dockerd-layerfs.sock`，data-root `/var/lib/docker`，cgroup v2、overlayfs、/dev/fuse 可用 |
| 辅助脚本 | `D:\26code\layerfs-setup\{wsl-install-docker.sh,wsl-fix-docker.sh,wsl-build-bundle.sh,dsh-3090.log,dump-config.json,cordis.patch.yml.bak}` |

## 构建步骤（可复现）
1. WSL 内 `docker build -t layerfs-352-runtime:node24 /root/layerfs/dsh/tools/history/runtime` → `docker image inspect --format '{{.Id}}'` 取 image ID。
2. WSL 内 `python3 tools/worktree.py register --worktree /root/layerfs --owner dsh --build-image rust:1.85.1-bookworm --runtime-image layerfs-352-runtime:node24 --sandbox-image layerfs-352-runtime:node24` → `prepare --platform linux` → `build --platform linux --profile release --jobs 6`，产出 sealed bundle（manifest.status=sealed / platform=linux）。
3. Windows 侧 `cd /d/26code/layerfs/dsh && DSH_SOURCE='D:\26code\deepseek-harness' pnpm run build`（tsdown v0.22.2 → packages/client/lib）。
4. WSL Docker 引擎：daemon.json 只留 data-root/default-runtime，用 systemd drop-in 覆盖 `ExecStart=/usr/bin/dockerd -H unix:///run/dockerd-layerfs.sock --containerd=/run/containerd/containerd.sock`（不能用 daemon.json 的 hosts，systemd 的 `-H fd://` 会与之冲突）；`systemctl disable --now docker.socket`。

## profile 安装（两个必须绕过的坑）
- **pnpm hoisted linker 缺陷**：`nodeLinker: hoisted` 下 `link:` 依赖的绝对盘符写法会生成坏 junction（目标 `<项目目录>\D:\26code\…`）→ dsh 报 `cannot resolve profile bundle`。解法：profile 内建 junction `web\layerfs-link → D:\26code\layerfs`，依赖写 `"dsh-layerfs": "link:layerfs-link/dsh/packages/dsh-layerfs"`（不以点开头，dsh 的 `anchorPathSpec` 不会改写它）。
- **bundles 不自动补加**：`dsh plugin --profile web install` 不会把已存在的依赖加进 `dsh.profile.bundles`；必须先 `remove dsh-layerfs` 再 `add`（reconcile 只收录 beforeDeps 里没有的新依赖）。
- **peer 依赖**：link 出去的 bundle 位于 dsh 安装之外，其 peer（@deepseek-ai/schemastery、dsh-session、cordis）无法解析 → 在 `D:\26code\layerfs\dsh\packages\host\node_modules\@deepseek-ai\` 下建 junction 指向 dsh 安装目录的对应包，否则 layerfs-host 激活失败（ERR_MODULE_NOT_FOUND）。

## profile 补丁（C:\Users\22923\.dsh\profiles\web\cordis.patch.yml 末尾）
```yaml
- id: layerfs-host
  config:
    image: sha256:46f55c587ed75ebc62ede1d993fc4f542002b91e191778c20e296153702e6fa9
    bundle: /root/.cache/layerfs-worktrees/layerfs-e9bb5836ed65/artifacts/build-linux-3ac532d8ed4d4711801212c94205d4a8
    docker: /run/dockerd-layerfs.sock
    wslDistribution: Ubuntu-24.04
    wslUser: root
    wslNode: /usr/local/bin/node
    wslHome: /var/lib/dsh-layerfs-windows/layerfs-dsh
    containerPrefix: layerfs-windows-
    home: 'C:\Users\22923\.dsh\profiles\web\dsh-layerfs\home'
    stateDir: 'C:\Users\22923\.dsh\profiles\web\dsh-layerfs'
- id: agent-preset-registry
  config:
    default: standard
```
> bundle 自带的 preset patch 会把默认 agent preset 改成 `layerfs-dsh-minimalist`（只有 bash/jobs/subagent，无读写文件工具），故在 profile 层覆盖回 `standard`。

## 验证
- 第二实例 `dsh web --no-open --port 3090` 启动后：`GET /layerfs/status` → `configured:true, missing:[]`，windows worker `layerfs-windows-wsl-worker` 运行中（WSL 内 `node /mnt/d/26code/layerfs/dsh/packages/host/src/windows/worker.js`），实例停止后 worker 自动退出。
- 官方证明脚本 `packages/host/tests/windows-real-local.mjs`（官方 windows-real.mjs + `docker: "/run/dockerd-layerfs.sock"`）→ **PASS**：建卷、fork、写、mount、exec、commit、>1MiB 文本/二进制、unmount、publish、history、idle 关闭、worker 重启、reopen、runtime status、清理卷全通过。
- Windows 测试套件 `pnpm test:windows`（frames/windows/host/bindings-shared）全 PASS；`sim`/`runtime`/`tools/history/*` 是 Linux-only（需要 /bin/sh、sqlite3、symlink 权限），在 Windows 上不适用。

## 本地代码改动（上游可提 issue）
- `dsh/packages/host/src/binding.js:88`：mkdir 锁原只容忍 `EEXIST`，Windows 并发时抛 `EPERM` → 改为同时容忍 `EPERM`（否则 bindings-shared 测试约半数失败）。

## 运维注意
- 改 WSL 部署设置必须重启 dsh web。
- WSL 内 `docker` CLI 默认仍指向 Docker Desktop 引擎；构建类命令要 `export DOCKER_HOST=unix:///run/dockerd-layerfs.sock`。
- Store 必须落在 WSL 引擎的本地 Linux 卷（`/var/lib/docker/volumes/...`），不能放 /mnt/c。
- 两个 dsh web 同机需各自 home/traceDir/containerPrefix。
