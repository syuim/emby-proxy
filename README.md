# emby-proxy

Emby 反代统一入口，前后端分离架构：

- **CF Worker 控制面**（`cf-worker/`）：客户端入口，管理 UI、307 路由调度、健康检测、配置 fan-out
- **Go 反代节点**（`proxy-go/`）：接收 cf-worker 推送的 emby 配置，反代 `/<emby_name>/...` 到真 Emby 后端

## 整体形状

```
客户端 → entry.example.com/embyA/path        [CF Worker]
                              │ 1. 解析 emby_name
                              │ 2. KV embys → primary=n_us, backups=[n_eu]
                              │ 3. KV health → primary healthy?
                              ↓
                         307 Location: https://us.example.com/embyA/path
                              ↓
客户端重发 → us-node (proxy-go) → 真 Emby
```

emby 配置由 cf-worker UI 写入 KV → 同步 fan-out 推送到所有节点。节点对等，故障转移在 Worker 路由层完成。

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

在 Cloudflare 控制台为 Worker 绑定自定义域名（emby 入口域名）。

### Step 3: 配置 emby

打开 `https://<worker-domain>/admin`，输入 ADMIN_TOKEN：

1. **Nodes 页**：添加节点（name + public_url）
2. **Embys 页**：为每个 emby 实例填 emby_name + backend_url + 主节点 + 备用节点
3. **Health 页**：等 1 分钟看 cron 探活，可手动重推

详见 `cf-worker/README.md`。

## 关键决策

| # | 选择 | 备注 |
|---|---|---|
| 跳转码 | 307 | 保留 method+body，Emby POST API 不丢 |
| 节点同步 | 全量推所有节点 | 节点对等，故障转移即时生效 |
| 健康检测 | cron 每 1min + 连续 2 次失败降级 / 1 次成功恢复 | 慢降级、快恢复 |
| 全部不健康 | fallback primary（不返 503） | 让客户端自己感知失败 |
| 推送协议 | `{version, proxies:[{path_prefix, backend_url}]}` | 沿用旧 schema，向后兼容 |

## 开发

```bash
# Go 反代
cd proxy-go && go test ./... && go build -o emby-proxy .

# CF Worker
cd cf-worker && npm install && npx tsc --noEmit && npx wrangler dev
```

## 环境变量

### proxy-go 节点

| 变量 | 说明 | 必填 |
|---|---|---|
| `EMBY_SYNC_TOKEN` | 与 cf-worker secret 同值 | 是 |
| `EMBY_PROXY_PORT` | 监听端口 | 否（默认 8080） |
| `EMBY_DATA_DIR` | 配置缓存目录 | 否（默认 `/app/data`） |

### cf-worker（wrangler secret）

| 变量 | 说明 |
|---|---|
| `ADMIN_TOKEN` | 管理 UI 登录 |
| `EMBY_SYNC_TOKEN` | 推节点用，与节点同值 |

## 历史

由 [tg-toolbox](https://github.com/syuim/tg-toolbox) 拆分而来，原 master Python 推送架构已退役，emby 反代由本仓库独立维护。
