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
            │  KV embys → node_id=n_us1
            │  KV health → n_us1 healthy?
            │      不健康则从其他节点中随机选一个健康的
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

# 2. 多账号用户：把 wrangler.toml 中的 account_id 改成你自己的（仓库里默认是 Suyu 账号）
#    单账号可省略
#    无 account_id 在 CI 非交互模式下会报 "More than one account available"

# 3. 设置 secrets（不要在面板上加 Plaintext Variables，会被部署清掉）
npx wrangler secret put ADMIN_TOKEN          # 管理 UI 登录
npx wrangler secret put EMBY_SYNC_TOKEN      # 必须和所有节点的 EMBY_SYNC_TOKEN 相同

# 4. 部署
npx wrangler deploy

# 5. 在 Cloudflare 控制台为 Worker 绑定自定义域名（你想用作 emby 入口的域名）
```

> ⚠️ **不要把 token 加成 Plaintext Variables**：CF Worker 后台的"环境变量"分 Secret 和 Variable 两种，明文 Variable 会被 `wrangler deploy` 用 `wrangler.toml` 中的 `[vars]` 段覆盖（toml 没声明 = 清空）。Secrets 不受此影响。详见根目录 `README.md`。

### 首次配置

打开 `https://<worker-domain>/admin`，输入 ADMIN_TOKEN 登录：

1. **Nodes 页**：添加你的 Go 节点（name + public_url，如 `https://us.example.com`）。同表展示健康/延迟/applied version/同步错误，可手动重推
2. **Embys 页**：为每个 emby 实例填 emby_name、backend_url、节点（单选）
3. 等 1 分钟看 cron 探活；指定节点不健康时路由层会随机切到其他健康节点

### 批量导入

`Import` 页粘贴 JSON：

```json
{
  "nodes": [
    {"name": "us-1", "public_url": "https://us.example.com"},
    {"name": "eu-1", "public_url": "https://eu.example.com"}
  ],
  "embys": [
    {"name": "embyA", "backend_url": "http://emby-a.internal:8096", "node_id": "n_xxxxxxxx"}
  ]
}
```

> 第一次导入时不知道 node id？先用 UI 加节点拿到 `n_xxxxxxxx`，再粘 embys；或者 import 时省略 `id` 字段，Worker 会自动分配。
>
> 兼容老格式：如果 emby 记录里写了 `primary_node_id`，会被当成 `node_id` 处理；`backup_node_ids` 已废弃，会被忽略。

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
| 故障转移 | 指定 node 不健康 → 其他节点中随机选健康的 | 不再维护主/备节点列表 |
| 健康检测 | cron 每 1min + 连续 2 次失败降级 / 1 次成功恢复 | 慢降级、快恢复 |
| 全部不健康 | fallback 到 emby 原始 node_id（不返 503） | 让客户端自己感知失败 |
| 管理认证 | ADMIN_TOKEN + cookie/Bearer | UI cookie HttpOnly+Secure |

## 开发

```bash
npm run typecheck     # tsc --noEmit
npm run dev           # wrangler dev (本地 Worker)
npm test              # vitest（占位，目前未提供测试）
```

本地 dev 用 `cf-worker/.dev.vars`（已 gitignore）作为环境变量来源：

```
ADMIN_TOKEN=local-dev-token
EMBY_SYNC_TOKEN=local-dev-sync-token
```

`wrangler dev` 启动时自动读取，与生产 secrets 完全独立，token 值不需要相同。

## 详细方案

详见仓库根 `README.md` 与 `AGENTS.md`。
