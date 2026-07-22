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

## 图片缓存

客户端请求路径匹配 `/Images/` 且为 GET、无 `Range` 头时，Worker 不走 307，而是直接代理上游并写入 Cloudflare Cache，缓存 7 天（stale-while-revalidate 1 天）。鉴权参数（`api_key`、`X-Emby-Token`、`X-MediaBrowser-Token`）在缓存 key 中被剔除。

## 部署

- **CF Worker**：`cf-worker/**` 做完改动后 → 提交到当前分支 → 合并到 `main` 推送，触发 GitHub Actions 自动部署。直接说"部署"或"合并到 main"即可，不需要问。
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
