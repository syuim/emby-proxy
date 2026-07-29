# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## 项目结构

- `cf-worker/`（TypeScript / CF Worker）：客户端入口、管理 UI、307 路由调度、健康检测、配置 fan-out
- `proxy-go/`（Go 1.22）：接收 cf-worker 推送的 emby 配置，反代 `/<emby_name>/...` 到真 Emby 后端

## 改完代码必须跑

```bash
cd proxy-go && go test ./...      # 改了 proxy-go/ 才跑
cd cf-worker && npx tsc --noEmit  # 改了 cf-worker/ 才跑（脚本：npm run typecheck）
```

> `cf-worker` 的 `npm test` 走 vitest 但目前没有测试文件，跑了等于空过。

## 协议契约（不可破坏）

cf-worker → 节点 `POST /admin/sync` payload **完全沿用旧 schema**，向后兼容老节点：

```json
{"version": <int>, "proxies": [{"path_prefix": "<emby_name>", "backend_url": "..."}]}
```

- `path_prefix` 是历史名字，对应 worker 内部 `emby_name`，**字段名不能动**
- 鉴权：`Authorization: Bearer $EMBY_SYNC_TOKEN`

## D1 schema 约束（不可回退）

`embys.node_id` **不能加 `FOREIGN KEY REFERENCES nodes(id)`**。直连模式用 `node_id = ''` 表示「不经过代理」，`''` 非 NULL 所以外键会照常校验且匹配不到任何节点 → 任何写入直连 emby 的操作都会 `FOREIGN KEY constraint failed`。该外键已由 `0002_embys_drop_node_fk.sql` 移除，节点引用的有效性改由应用层保证（`checkNodeRefs` 校验存在性，删节点时先解引用）。

改 emby 字段请用**定向 `UPDATE`**，不要走整表 DELETE + 重插：后者是单个事务，任意一行写入失败会静默回滚掉全部改动。

## 保留路径与命名规则

不能作为 `emby_name` 的保留字：`admin / api / health / __health / favicon.ico / robots.txt / .well-known / _`。

`emby_name` 还需满足正则 `^[a-zA-Z0-9_-]{1,32}$`，加新 emby 或写测试时避开上述约束。

## 故障转移行为

emby 指定的 `node_id` 不健康 → router 从其他节点中**随机**挑健康的 → 全不健康兜底原 `node_id`（不返 503）。健康检测：cron 每 10 分钟探活，连续 2 次失败降级 / 1 次成功恢复。

探活降频：节点连续失败 ≥5 次后，30 分钟内只真实探测一次，避免反复打已知死节点。探测成功后若节点 `applied_version` 落后 KV，会异步补推一次配置。

## 必需环境变量

### proxy-go 节点

| 变量 | 说明 | 必填 |
|---|---|---|
| `EMBY_SYNC_TOKEN` | 与 cf-worker secret 同值，校验推送鉴权 | 是 |
| `EMBY_PROXY_PORT` | 监听端口 | 否（默认 `8080`） |
| `EMBY_DATA_DIR` | 配置缓存目录 | 否（Go 默认 `./data`；Docker/compose 使用 `/app/data`） |

### cf-worker（wrangler secrets）

`ADMIN_TOKEN`（管理 UI 登录）、`EMBY_SYNC_TOKEN`（推节点用）、`DIRECT_PROXY_TOKEN`（可选，直连代理自动注册）。

- `DIRECT_PROXY_TOKEN` 可不设，不设则功能关闭。设置后 `/<token>/https://backend/path` 会被 cf-worker 拦截，自动在 KV 中创建 emby 配置（分配到默认节点），然后 307 到该节点代理。
- **风险**：此 token 出现在 URL 路径中，任何拿到路径日志的人等同于拥有 open-proxy 权限。建议用强随机字符串。

**关键约束**：
- `EMBY_SYNC_TOKEN` 在 cf-worker 与所有节点上必须 **byte-for-byte** 一致，不一致 → 节点 401
- ⚠️ **不要在 CF 面板上加 Plaintext Variables**：`wrangler deploy` 会用 `wrangler.toml` 中 `[vars]` 段覆盖明文变量（toml 没声明 = 部署后清空）。所有 token 走 `wrangler secret put`
- `wrangler.toml` 已锁定 `account_id`（Suyu 账号），CI 非交互模式必需

本地 dev：`cf-worker/.dev.vars`（已 gitignore），与生产 secrets 完全独立。

## 图片缓存（已禁用）

图片缓存功能已注释禁用，图片/视频统一走节点 307 代理。代码保留在 `router.ts` 中，仅注释掉调用点，恢复只需取消注释两处 `isCacheableImageRequest`/`serveCachedImage` 调用。

## 部署

- **CF Worker**：`cf-worker/**` 做完改动后 → 提交到当前分支 → 合并到 `main` 推送，触发 GitHub Actions 自动部署。直接说"部署"或"合并到 main"即可，不需要问。
- **D1 migration**：**CI 不跑 migration**，需本地执行：
  ```bash
  cd cf-worker && CLOUDFLARE_ACCOUNT_ID=9a2c5f84e3346b4d2310792e4f759881 npx wrangler d1 migrations apply emby-proxy --remote
  ```
  - `CLOUDFLARE_ACCOUNT_ID` 必须显式给：`d1 migrations` 子命令**不读 `wrangler.toml` 的 `account_id`**（wrangler 3.x），多账号下会报 "More than one account available"。
  - 已实测：`CLOUDFLARE_API_TOKEN` 这个 CI secret **只有 Workers 权限、没有 D1 权限**，即使显式传 account id 也照样 `7403`。想接进 CI 得先给该 token 加 `Account → D1 → Edit`；在那之前不要把 migration 步骤加进 workflow —— 它排在 deploy 前面，一失败会把所有 Worker 部署连带 skip。
  - 本地若也报 `7403`，先跑一次 `npx wrangler whoami` 刷新 OAuth token 再重试。
- **Go 节点**：使用 `Agent` 调用 `ops` subagent 执行，机器信息以 ops agent 为准。

### 部署后验证

1. **CF Worker**：`gh run list --branch main --limit 1 --json conclusion,displayTitle` → 确认 `conclusion` 为 `"success"`
2. **Go 节点**：`curl -s http://<host>:8080/__health` → 确认返回 `{"ok":true,...}`；`docker logs --tail 5 <container>` → 确认无启动错误
3. **Direct Proxy**（如已设置 `DIRECT_PROXY_TOKEN`）：`curl -s -o /dev/null -w "%{http_code}" https://<worker>/{token}/https://example.com` → 返回 `307`
4. **面板验证**：`https://<worker>/admin` → 节点列表应有"默认"标记，新增 emby 记录

## 提交信息

中文 conventional commit，格式 `<type>: <中文描述>` 或 `<type>(<scope>): <中文描述>`。例：

- `fix: SSRF 防护放宽，允许 CDN 跨域重定向`
- `refactor(cf-worker): emby 简化为单节点 + 控制面改 COSS UI 风格`

正文按需含：问题/需求描述、修复或实现思路、复现路径。

## 诊断命令

| # | 目标 | 命令 |
|---|---|---|
| 1 | 节点日志（dash） | `ssh -i ~/.ssh/syu_vps -p 22 admin@dash.127315.xyz 'sudo docker logs --tail 100 proxy-go-emby-proxy-1'` |
| 2 | Worker 实时日志 | `cd cf-worker && npx wrangler tail --format pretty` |
| 3 | KV 内容 | `cd cf-worker && npx wrangler kv key list --binding=EMBY_KV` |
