# emby-proxy

Emby 反代统一入口，前后端分离架构：

- **CF Worker 控制面**（`cf-worker/`）：客户端入口，管理 UI、307 路由调度、健康检测、配置 fan-out
- **Go 反代节点**（`proxy-go/`）：接收 cf-worker 推送的 emby 配置，反代 `/<emby_name>/...` 到真 Emby 后端

## 整体形状

```
客户端 → entry.example.com/embyA/path        [CF Worker]
                              │ 1. 解析 emby_name
                              │ 2. KV embys → node_id=n_us
                              │ 3. KV health → n_us healthy?
                              │    不健康则从其他节点中随机挑一个健康的
                              ↓
                         307 Location: https://us.example.com/embyA/path
                              ↓
客户端重发 → us-node (proxy-go) → 真 Emby
```

emby 配置由 cf-worker UI 写入 KV → 同步 fan-out 推送到所有节点。节点对等，故障转移在 Worker 路由层完成（指定节点不健康 → 从剩余节点中**随机挑一个健康节点**；全部不健康 → 兜底原节点）。

## 快速部署

### Step 1: 部署 emby 反代节点（每台机器一个）

```bash
cd proxy-go
docker build -t emby-proxy .
docker run -d --name emby-proxy --restart unless-stopped \
  -e EMBY_SYNC_TOKEN="your-secret-token" \
  -e EMBY_PROXY_PORT=8080 \
  -e EMBY_DATA_DIR=/app/data \
  -p 8080:8080 \
  -v "$(pwd)/data:/app/data" \
  emby-proxy
```

### Step 2: 部署 cf-worker 控制面

```bash
cd cf-worker
npm install
npx wrangler kv:namespace create EMBY_KV       # 把返回的 id 填到 wrangler.toml
npx wrangler secret put ADMIN_TOKEN            # 控制面登录
npx wrangler secret put EMBY_SYNC_TOKEN        # 必须与节点同值
npx wrangler deploy
```

在 Cloudflare 控制台为 Worker 绑定一个自定义域名（如 `emby.yourdomain.com`）。**同一个域名同时承担两个角色**：

- `https://emby.yourdomain.com/admin` → 管理后台
- `https://emby.yourdomain.com/<emby_name>/...` → 客户端 emby 入口（被 307 转到健康节点）

`admin / api / health / __health / favicon.ico / robots.txt / .well-known` 已被列为保留字，创建 emby 时不能使用。

### Step 3: 配置 emby

打开 `https://<worker-domain>/admin`，输入 ADMIN_TOKEN：

1. **Nodes 页**：添加节点（name + public_url），同表展示健康/延迟/applied version/同步错误，可手动重推
2. **Embys 页**：为每个 emby 实例填 emby_name + backend_url + 节点（单选）
3. 等 3 分钟看 cron 探活；不健康节点会被路由层随机切到其他健康节点

详见 `cf-worker/README.md`。

## 关键决策

| # | 选择 | 备注 |
|---|---|---|
| 跳转码 | 307 | 保留 method+body，Emby POST API 不丢 |
| 节点同步 | 全量推所有节点 | 节点对等，故障转移即时生效 |
| 故障转移 | 指定 node 不健康 → 其他节点中随机选健康的 | 不再维护主/备节点列表，配置最简 |
| 健康检测 | cron 每 3min + 连续 2 次失败降级 / 1 次成功恢复 | 慢降级、快恢复 |
| 全部不健康 | fallback 到 emby 原始 node_id（不返 503） | 让客户端自己感知失败 |
| 推送协议 | `{version, proxies:[{path_prefix, backend_url}]}` | 沿用旧 schema，向后兼容 |

## 开发

```bash
# Go 反代
cd proxy-go && go test ./... && go build -o emby-proxy .

# CF Worker
cd cf-worker && npm install && npx tsc --noEmit && npx wrangler dev
```

## 自动部署

`cf-worker/` 任何改动 push 到 `main` 会触发 [`.github/workflows/deploy-cf-worker.yml`](.github/workflows/deploy-cf-worker.yml) 自动部署到 Cloudflare。

**前置准备**（首次必须本地手动一次）：

1. `cd cf-worker && npx wrangler login` 浏览器登录
2. `npx wrangler kv namespace create EMBY_KV` 创建 KV，把 id 填回 `wrangler.toml`
3. 多账号用户需把 `account_id` 写进 `wrangler.toml`（已写入 Suyu 账号），否则 `wrangler` 在 CI 非交互模式下会报 `More than one account available`
4. `npx wrangler secret put ADMIN_TOKEN` / `npx wrangler secret put EMBY_SYNC_TOKEN` 写入 secrets
5. `npx wrangler deploy` 首次部署 + 在 CF 控制台为 worker 绑定自定义域名

**启用 CI 自动部署**：

GitHub 仓库 Settings → Secrets and variables → Actions 加两个 secret：

| Secret | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API Token（[创建页面](https://dash.cloudflare.com/profile/api-tokens) → 用 `Edit Cloudflare Workers` 模板） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID（dash 右侧栏） |

> ⚠️ KV namespace ID 和 wrangler secrets 不会通过 CI 部署，必须先在本地手动完成。CI 只负责更新代码。

### ⚠️ 关于 Variables vs Secrets 的坑

CF Worker 后台的"环境变量"分两种，行为完全不同：

| 类型 | 加密 | `wrangler deploy` 行为 |
|---|---|---|
| **Secret** | ✅ 加密 | 部署不覆盖。只有 `wrangler secret put` 或面板手删能改 |
| **Variable**（明文） | ❌ 明文 | **每次部署会用 `wrangler.toml` 中的 `[vars]` 段覆盖** —— toml 里没声明 = 部署后清空 |

**结论**：所有 token / 密钥都用 Secret 管理。如果之前在面板上加的是"Plaintext Variable"，每次 CI deploy 都会把它清掉。修复办法：

```bash
cd cf-worker
npx wrangler secret put ADMIN_TOKEN       # 改用 secret
npx wrangler secret put EMBY_SYNC_TOKEN
# 然后去 CF 面板删掉同名的 Plaintext Variables（避免重复定义）
```

### 本地 dev 环境变量

`wrangler dev` 不会读生产 secrets，本地用 `cf-worker/.dev.vars`（已 gitignore）：

```
ADMIN_TOKEN=local-dev-token
EMBY_SYNC_TOKEN=local-dev-sync-token
```

本地与生产 token 值**完全独立**，不需要相同（除非你的本地 dev 直连真实节点）。

## Token 共享与鉴权

`EMBY_SYNC_TOKEN` 必须**同时**在 cf-worker 和每个 proxy-go 节点上配置，且**两边的字符串必须完全一致**（byte-for-byte）。

```
cf-worker (env: EMBY_SYNC_TOKEN)
    │  POST https://node.example.com/admin/sync
    │  Authorization: Bearer <EMBY_SYNC_TOKEN>
    │  Body: {version, proxies:[...]}
    ↓
proxy-go (env: EMBY_SYNC_TOKEN)
    │  checkAuth: 比较 header 中的 token 与自己的 EMBY_SYNC_TOKEN
    │
    ├─ 一致 → 200 接受快照，落盘 emby_slave_config.json
    └─ 不一致 → 401 unauthorized
```

| 角色 | 用途 |
|---|---|
| cf-worker | 出站方，写入推送请求的 `Authorization: Bearer` |
| proxy-go 节点 | 入站方，校验请求头中的 token 是否与自身环境变量一致 |

`ADMIN_TOKEN` 仅 cf-worker 需要，用于管理 UI 登录，**与 `EMBY_SYNC_TOKEN` 是两个独立的 secret**，不要混用。

## 环境变量

### proxy-go 节点

| 变量 | 说明 | 必填 |
|---|---|---|
| `EMBY_SYNC_TOKEN` | 校验 cf-worker 推送鉴权 | 是 |
| `EMBY_PROXY_PORT` | 监听端口 | 否（默认 8080） |
| `EMBY_DATA_DIR` | 配置缓存目录 | 否（默认 `/app/data`） |

### cf-worker（wrangler secret）

| 变量 | 说明 |
|---|---|
| `ADMIN_TOKEN` | 管理 UI 登录 |
| `EMBY_SYNC_TOKEN` | 推送节点时的 Bearer token |

## 历史

由 [tg-toolbox](https://github.com/syuim/tg-toolbox) 拆分而来，原 master Python 推送架构已退役，emby 反代由本仓库独立维护。
