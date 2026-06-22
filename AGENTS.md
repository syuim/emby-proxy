# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## 双子项目

- **CF Worker 控制面**（`cf-worker/`，TypeScript）：客户端入口、管理 UI、307 路由调度、健康检测、配置 fan-out
- **Go 反代节点**（`proxy-go/`，Go 1.22）：接收 cf-worker 推送的 emby 配置，反代 `/<emby_name>/...` 到真 Emby 后端

> 由 [tg-toolbox](https://github.com/syuim/tg-toolbox) 拆分而来；老的 master Python 推送架构已退役。

## 改完代码必须跑

```bash
cd proxy-go && go test ./...             # 改了 proxy-go/ 才跑
cd cf-worker && npx tsc --noEmit         # 改了 cf-worker/ 才跑
```

## 整体形状

```
客户端 → entry.example.com/embyA/path        [CF Worker]
                              │ 1. 解析 emby_name
                              │ 2. KV embys → node_id=n_us
                              │ 3. KV health → n_us healthy?
                              │    不健康则从其他节点中随机挑健康的
                              ↓
                         307 Location: https://us.example.com/embyA/path
                              ↓
客户端重发 → us-node (proxy-go) → 真 Emby
```

emby 配置由 cf-worker UI 写入 KV → 同步 fan-out 推送到所有节点的 `/admin/sync`。节点对等，故障转移在 Worker 路由层完成。

## 模块结构

### CF Worker (`cf-worker/`)

- `src/index.ts` — 入口（fetch + scheduled）
- `src/router.ts` — 客户端路径解析、节点选择、307
- `src/health.ts` — cron 探活 + version 反向校验补推
- `src/sync.ts` — 写后 fan-out POST 到节点 `/admin/sync`
- `src/storage.ts` — KV 读写封装
- `src/admin/` — 管理 UI 后端（login / nodes / embys / health / import）
- `src/admin.html` — 管理 UI 单页（COSS UI 风格 + 三态主题）

KV schema（`EMBY_KV` 命名空间）：
- `nodes`: `{version, nodes: [{id:"n_xxxxxxxx", name, public_url, created_at}]}`
- `embys`: `{version, embys: [{name, backend_url, node_id, created_at}]}`
- `health`: `{updated_at, nodes: {n_xxx: {healthy, last_check, consecutive_fails, last_latency_ms, applied_version, last_sync_error}}}`

### Go 节点 (`proxy-go/`)

- `main.go` — `:8080` 起 HTTP，注册路由
- `proxy.go` — 反代逻辑（`/<emby_name>/...` → 后端）
- `admin.go` — `/admin/sync`（接收快照）+ `/admin/status`（汇报 applied_version）
- `store.go` — 内存映射 + `data/emby_slave_config.json` 持久化
- `Dockerfile` — `golang:1.22-alpine` 多阶段 → `alpine:3.19`，暴露 `:8080`，healthcheck `/__health`
- `docker-compose.yml` — 独立 compose，仅 emby-proxy 服务

## 协议契约（不可破坏）

cf-worker → 节点 `/admin/sync` payload **完全沿用旧 schema**（向后兼容老节点）：

```json
{"version": <int>, "proxies": [{"path_prefix": "<emby_name>", "backend_url": "..."}]}
```

字段名 `path_prefix` 是历史名字，对应 worker 内部 `emby_name`。Bearer 头 `Authorization: Bearer $EMBY_SYNC_TOKEN`。

## 必需环境变量

### proxy-go 节点

| 变量 | 说明 | 必填 |
|---|---|---|
| `EMBY_SYNC_TOKEN` | 与 cf-worker secret 同值，校验推送鉴权 | 是 |
| `EMBY_PROXY_PORT` | 监听端口 | 否（默认 8080） |
| `EMBY_DATA_DIR` | 配置缓存目录 | 否（默认 `/app/data`） |

### cf-worker（wrangler secrets）

| 变量 | 说明 |
|---|---|
| `ADMIN_TOKEN` | 管理 UI 登录 |
| `EMBY_SYNC_TOKEN` | 推节点用，与节点 env 同值 |

> ⚠️ **不要在 CF 面板上加 Plaintext Variables**：`wrangler deploy` 会用 `wrangler.toml` 中的 `[vars]` 段覆盖明文变量（toml 没声明 = 部署后清空）。Secrets 不受此影响。详见 README。

本地 dev：`cf-worker/.dev.vars`（已 gitignore），`wrangler dev` 自动读取，与生产 secrets 完全独立。

## CI/CD

`cf-worker/**` 改动 push 到 `main` → 触发 `.github/workflows/deploy-cf-worker.yml` → `cloudflare/wrangler-action@v3` 自动部署到 Cloudflare。

`proxy-go/` 暂无 CI，靠 SSH 远程 `git pull && docker compose build && docker compose up -d`。

## 部署

SSH 密钥：本地 `~/.ssh/syu_vps`
代码仓库：`git@github.com:syuim/emby-proxy.git`

### 服务器信息

| 角色 | Host | Port | User | 部署目录 |
|---|---|---|---|---|
| Emby 反代节点 | dash.127315.xyz | 22222 | root | `/root/docker/emby-proxy` |
| CF Worker 控制面 | Cloudflare 边缘（无独立服务器） | — | — | — |

> dash 同时跑 tg-toolbox bot（`/root/docker/bot`）和 emby-proxy 反代节点（`/root/docker/emby-proxy`），两个 docker compose 互不影响。
> 老 tg-toolbox `bot/proxy-go` 子目录在拆库后已废弃，部署位置迁到独立目录 `emby-proxy/`。

> dash 远端 `~/.zshrc` 已 export `EMBY_SYNC_TOKEN`，远程命令通过 `bash -lc`（加载 zshrc）即可继承，不需要本地传值。

### proxy-go 节点（远程拉取编译）

代码 push 到 `origin/main` 后：

```bash
ssh -i ~/.ssh/syu_vps -p 22222 root@dash.127315.xyz \
  "cd /root/docker/emby-proxy && git pull && cd proxy-go && docker compose build && docker compose up -d"
```

首次部署：

```bash
ssh -i ~/.ssh/syu_vps -p 22222 root@dash.127315.xyz bash -lc '
  cd /root/docker && git clone git@github.com:syuim/emby-proxy.git && \
  cd emby-proxy/proxy-go && \
  printf "EMBY_SYNC_TOKEN=%s\n" "$EMBY_SYNC_TOKEN" > .env && \
  docker compose up -d --build
'
```

`bash -lc` 会加载 zshrc 里 export 的 `EMBY_SYNC_TOKEN`，写入节点目录的 `.env`。

验证：`curl http://dash.127315.xyz:8080/__health` 返回 `ok`。

### CF Worker（自动 + 手动）

**自动**：push `cf-worker/` 改动 → CI 跑 `npx wrangler deploy`。

**手动**：

```bash
cd cf-worker
npx wrangler login                       # 首次浏览器登录
npx wrangler kv:namespace create EMBY_KV # 把返回的 id 填到 wrangler.toml
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put EMBY_SYNC_TOKEN
npx wrangler deploy
```

**多账号锁定**：`wrangler.toml` 已写入 `account_id = "9a2c5f84e3346b4d2310792e4f759881"`（Suyu 账号），CI 非交互模式才能走通。

### 部署验证

| # | 检查 | 命令 |
|---|---|---|
| 1 | 节点健康 | `curl http://dash.127315.xyz:8080/__health` → `ok` |
| 2 | Worker 健康 | `curl https://<worker-domain>/__health` → `ok` |
| 3 | 端到端 307 | `curl -I https://<worker-domain>/<emby_name>/` 看 Location |

### 关键运维点

- **配置同步**：cf-worker 任意 nodes/embys 变更 → 自动 fan-out 到所有节点。节点重启后从 `data/emby_slave_config.json` 恢复，无状态可独立重启
- **健康检测**：cron 每 1 分钟探活节点 `/__health`，连续 2 次失败降级 / 1 次成功恢复
- **故障转移**：emby 指定 node_id 不健康 → router 从其他节点中**随机**挑健康的 → 全不健康兜底原 node_id
- **EMBY_SYNC_TOKEN 双边一致**：cf-worker secret 与所有节点 env 必须 byte-for-byte 完全相同，不一致 → 节点 401

## 开发流程

### 修改 cf-worker

1. 改 `src/*.ts`，本地 `npm run dev` / `npx wrangler dev` 烟雾测试
2. `npx tsc --noEmit`
3. 提交 + push → CI 自动部署

### 修改 proxy-go

1. 改 `proxy-go/*.go`，`go test ./...`
2. 协议变更需保持 `/admin/sync` payload 向后兼容（`path_prefix` 字段名不能动）
3. 提交 + push → SSH dash 拉取重建

### 添加新节点

1. SSH 新机器，clone 仓库 + `docker compose up -d`
2. cf-worker 管理 UI Nodes 页加节点（name + public_url）
3. 等 1 分钟看 health 变绿，applied_version 与 cf-worker 一致

### 添加新 emby

1. 管理 UI Embys 页：填 emby_name + backend_url + 选节点
2. 立即 fan-out 推送，验证 `https://<worker-domain>/<emby_name>/` 能 307 到节点

## 提交信息

中文 conventional commit，格式 `<type>: <中文描述>`。例：

- `fix: SSRF 防护放宽，允许 CDN 跨域重定向`
- `refactor(cf-worker): emby 简化为单节点 + 控制面改 COSS UI 风格`
- `docs: 同步部署信息到当前实现状态`

正文按需含：问题/需求描述、修复或实现思路、复现路径。

## 排查问题

- ❌ 不靠假设，✅ 必须有日志/数据支撑后再修
- 🚫 严禁未定位根因就开始改代码

常用诊断：

| # | 目标 | 命令 |
|---|---|---|
| 1 | 节点日志 | `ssh dash 'docker logs --tail 100 emby-proxy-emby-proxy-1'` |
| 2 | Worker 实时日志 | `cd cf-worker && npx wrangler tail --format pretty` |
| 3 | KV 内容 | `cd cf-worker && npx wrangler kv key list --binding=EMBY_KV` |

## 沟通

- 中文回复，言简意赅，巧用 Emoji ✨
- 多条数据**用表格 + 序号**
- 复杂任务先用 Plan Mode 规划，简单改动直接动手
- 多任务时优先 Subagent 并发
