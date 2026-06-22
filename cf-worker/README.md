# cf-worker — Emby Router 控制面

CF Worker，承担 emby 反代的：
1. **路由调度**：客户端访问 `https://入口域名/<emby_name>/...` → 查 KV → 选健康节点 → **307** 转发
2. **管理 UI**：`/admin` 单页，配置 nodes / embys / 故障转移
3. **健康检测**：cron 每 1 分钟探活节点 `/__health`
4. **配置同步**：写 KV 后 fan-out 推到所有节点的 `/admin/sync`

## 架构

```
客户端 → entry.example.com/embyA/path
            │ (CF Worker)
            │  解析 emby_name=embyA
            │  KV embys → primary=n_us1, backup=[n_eu1]
            │  KV health → n_us1 healthy?
            ↓
       307 Location: https://us.example.com/embyA/path
            ↓
       客户端重发 → us-node (proxy-go) → 真 emby
```

emby 配置全量推送到所有节点（节点对等），Worker 只决定路由到哪个 → 故障转移自动生效。

## 部署

### 前置

- Cloudflare 账号（Workers Free 即可，cron 最小 1 分钟）
- Node.js 18+
- 已部署的 proxy-go 节点（每台一个 `public_url`）
- 节点的 `EMBY_SYNC_TOKEN` 环境变量

### 步骤

```bash
cd cf-worker
npm install              # 或 pnpm install

# 1. 创建 KV namespace（生产 + 预览）
npx wrangler kv:namespace create EMBY_KV
# 把返回的 id 填到 wrangler.toml 的 [[kv_namespaces]] id 字段

# 2. 设置 secrets
npx wrangler secret put ADMIN_TOKEN          # 管理 UI 登录
npx wrangler secret put EMBY_SYNC_TOKEN      # 必须和所有节点的 EMBY_SYNC_TOKEN 相同

# 3. 部署
npx wrangler deploy

# 4. 在 Cloudflare 控制台为 Worker 绑定自定义域名（你想用作 emby 入口的域名）
```

### 首次配置

打开 `https://<worker-domain>/admin`，输入 ADMIN_TOKEN 登录：

1. **Nodes 页**：添加你的 Go 节点（name + public_url，如 `https://us.example.com`）
2. **Embys 页**：为每个 emby 实例填 emby_name、backend_url、主节点、备用节点
3. **Health 页**：等 1 分钟看 cron 探活结果，可手动重推

### 批量导入

`Import` 页粘贴 JSON：

```json
{
  "nodes": [
    {"name": "us-1", "public_url": "https://us.example.com"},
    {"name": "eu-1", "public_url": "https://eu.example.com"}
  ],
  "embys": [
    {"name": "embyA", "backend_url": "http://emby-a.internal:8096",
     "primary_node_id": "n_xxxxxxxx", "backup_node_ids": []}
  ]
}
```

> 第一次导入时不知道 node id？先用 UI 加节点拿到 `n_xxxxxxxx`，再粘 embys；或者 import 时省略 `id` 字段，Worker 会自动分配。

## 与节点 (proxy-go) 的契约

Worker 推到节点的 `/admin/sync` payload **完全沿用旧 schema**（向后兼容）：

```json
{
  "version": 12,
  "proxies": [{"path_prefix": "embyA", "backend_url": "http://emby.internal:8096"}]
}
```

- 字段名 `path_prefix` 是历史名字，对应新模型里的 `emby_name`。
- Bearer token 头 `Authorization: Bearer $EMBY_SYNC_TOKEN`。
- 节点端代码完全不需要改动。

## 关键决策

| # | 选择 | 备注 |
|---|---|---|
| 跳转码 | 307 | 保留 method+body，Emby POST API 不丢 |
| 节点同步 | 全量推所有节点 | 节点对等，故障转移即时生效 |
| 健康检测 | cron 每 1min + 连续 2 次失败降级 / 1 次成功恢复 | 慢降级、快恢复 |
| 全部不健康 | fallback primary（不返 503） | 让客户端自己感知失败 |
| 管理认证 | ADMIN_TOKEN + cookie/Bearer | UI cookie HttpOnly+Secure |

## 开发

```bash
npm run typecheck     # tsc --noEmit
npm run dev           # wrangler dev (本地 Worker)
npm test              # vitest（占位，目前未提供测试）
```

## 详细方案

详见仓库根 `README.md` 与 `AGENTS.md`。
