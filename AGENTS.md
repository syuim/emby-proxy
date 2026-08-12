# Repository Guidelines

本仓库提供 Emby 反代统一入口，采用前后端分离架构。`AGENTS.md` 是权威文档：改代码、部署前必须阅读，并以代码与本文档为准；`README.md` 若与本文档不一致，以本文档和代码为准。

## Project Structure & Module Organization

- `cf-worker/`：TypeScript / Cloudflare Worker 控制面。承担客户端入口、管理 UI、`/emby/<name>` 路由调度、健康检测、配置 fan-out 与本地代理。源码在 `src/`，测试为 `src/*.test.ts`，D1 migration 在 `migrations/`。
- `proxy-go/`：Go 1.22 反代节点。接收 Worker 推送的 emby 配置，将 `/<emby_name>/...` 反代到真 Emby 后端。入口为 `main.go`，核心实现分布在 `proxy.go`、`admin.go`、`store.go`、`backend_prober.go`。
- `README.md`：项目概览与部署说明。`AGENTS.md` 与代码有冲突时，以 `AGENTS.md` 和代码为准。

## Build, Test, and Development Commands

```bash
# cf-worker：类型检查、vitest 测试、本地 dev
cd cf-worker
npm run typecheck   # tsc --noEmit，改 cf-worker 后必须跑
npm test            # vitest run，覆盖 src/*.test.ts
npm run dev         # wrangler dev，本地读取 .dev.vars

# proxy-go：测试、本地编译
cd proxy-go
go test ./...       # 改 proxy-go 后必须跑
go build -o emby-proxy .
```

本地开发环境变量写入 `cf-worker/.dev.vars`（已 gitignore），与生产 secrets 完全独立。

## Coding Style & Naming Conventions

- TypeScript：使用 `strict` 配置，禁止未使用的局部变量与参数；类名使用 PascalCase，变量与函数使用 camelCase，常量使用 SCREAMING_SNAKE_CASE。
- Go：遵循标准库风格，结构体字段使用 PascalCase，函数与变量使用 camelCase。
- `emby_name` 必须满足 `^[a-zA-Z0-9_-]{1,32}$`，且不能使用保留字：`admin / api / health / __health / favicon.ico / robots.txt / .well-known / _ / tmdb`。
- URL 一级命名空间硬切换：emby 相关全部挂在 `/emby/...` 下，节点协议路径不含 `/emby` 前缀。
- 不使用会破坏既有协议或 schema 的重构。协议契约与 D1 schema 约束见下文，属不可回退项。

## Testing Guidelines

- cf-worker 使用 Vitest，测试文件命名 `src/*.test.ts`；当前覆盖 `isPrivateHost`、`normalizePath`、`isCacheableImageRequest`、`buildTargetUrl`、`buildImageCacheKey` 等纯函数。
- proxy-go 使用标准库 `testing`，测试文件为 `proxy_test.go`，重点覆盖重定向跟随、SSRF 防护、未知前缀 404、CORS 与 `normalizeOrigin`。
- 改动必须保持测试通过；新增行为应尽量补充对应纯函数或处理流程的测试，并以可复现的输入输出描述预期。

## Commit & Pull Request Guidelines

- 提交信息使用中文 conventional commit，格式 `<type>: <中文描述>` 或 `<type>(<scope>): <中文描述>`，scope 示例：`cf-worker`。
- 正文按需包含问题/需求描述、修复或实现思路、复现路径。
- 示例：`fix: SSRF 防护放宽，允许 CDN 跨域重定向`、`refactor(cf-worker): emby 简化为单节点 + 控制面改 COSS UI 风格`。
- PR 应说明改动背景、影响范围与验证方式；涉及 cf-worker 的改动需提供类型检查/测试结果，涉及 proxy-go 的改动需提供 `go test` 结果；如有部署影响，补充部署验证记录。

## Protocol Contracts & D1 Schema Constraints

### Sync 协议

cf-worker 到节点的 `POST /admin/sync` payload 完全沿用旧 schema，向后兼容老节点：

```json
{"version": <int>, "proxies": [{"path_prefix": "<emby_name>", "backend_url": "..."}]}
```

`path_prefix` 是历史字段名，对应 Worker 内部 `emby_name`，字段名不能动。鉴权使用 `Authorization: Bearer $EMBY_SYNC_TOKEN`。

### D1 约束

`embys.node_id` 不能加 `FOREIGN KEY REFERENCES nodes(id)`。直连模式用 `node_id = ''` 表示“不经过代理”，`''` 非 NULL 会触发外键校验失败；该外键已由 `0002_embys_drop_node_fk.sql` 移除，节点引用有效性改由应用层保证。

修改 emby 字段请使用定向 `UPDATE`，不要走整表 DELETE + 重插。整表 DELETE + 重插是单个事务，任意一行写入失败会静默回滚全部改动。

## URL Namespace & Naming Rules

一级路径按功能划分（硬切换，无旧路径兼容）：

- `/emby/<name>/path`：名称访问，走节点选择
- `/emby/http(s)://...`：地址访问（原样或 URL 编码），必走本地代理，无鉴权
- `/emby/tmdb/...`：TMDB 反代
- `/emby/admin`：管理 UI / API
- `/img`：通用图片代理，无鉴权
- `/douban/...`：豆瓣 Stremio addon 反代，无鉴权。**负载均衡**：每次请求先探活 `https://fw-douban.laoz.org/suyu/manifest.json`（2xx/3xx 可达）；可达 → 307 到 `https://fw-douban.laoz.org/`（去 `/douban` 前缀，客户端后续全走 fw）；不可达 → 回退 `http://rn.127315.xyz:31001` 直连反代（不跳转）。探活结果 isolate 内存缓存：可达 15s，不可达 5m→10m→30m→1h→2h→4h→8h→16h→24h（指数退避封顶 24h），恢复后从 15s 重新开始；探测失败不阻塞本次请求（直接回退反代）。反代时 UA 透传保留 forward 行为；注入 `X-Forwarded-Host/Proto` 使 addon 生成的 origin 绝对 URL（图片 `/image-proxy`、保存配置返回的 `manifestUrl`）指向 Worker（线上实测 `X-Forwarded-Proto` 未生效，addon 退回 http scheme，改写需兜底 http/https 双变体）；响应文本统一前缀改写保证闭环：JSON 绝对 URL、HTML root-relative 链接（form action / assets / icon，200 与 401 登录失败页均改写）、JS `fetch("/configure")` 路径；`history.replaceState` 的 `/${configId}/configure` 模板**不**改写（configId 提取自改写后 manifestUrl 第一段，加前缀会变 `/douban/douban/configure`；不改写则地址栏落在 `/douban/configure`，刷新 302 回默认配置页）。仅 `/image-proxy` 与 `/assets/` 走 CF 边缘缓存，catalog 等 JSON 不缓存（UA 不进 cache key，forward UA 的 `tmdb:` ID 响应会污染普通缓存）
- 根路径 `/` 302 到 `/emby/admin`；`/__health` 保留在顶层；其余一级路径 404

节点协议路径不含 `/emby` 前缀：307 到节点仍是 `/<name>/subpath`。只有两种访问形式：名称访问 `/emby/<name>/path` 走节点选择（local 亦在其中），地址访问 `/emby/http(s)://...`（原样或 URL 编码）必走本地代理；不存在 `/emby/<name>/<url>` 形式。

地址访问原样形式会自动注册 emby，`node_id`/`home_node_id` 固定为 `local`，只写 emby 记录、不 bump version、不 fan-out 推节点（否则 cron 会误判补推）；编码形式是本地代理改写的回流产物，不触发注册。URL 自带 query（CDN 签名）与外层 query 会合并。地址访问与图片代理均无鉴权，等同 open proxy，依赖域名不公开。

## Failover Behavior

`embys` 有两个节点字段：`node_id` = 当前生效节点（故障转移会改写），`home_node_id` = 原始配置节点（只有显式改配置才更新，是恢复切回的目标）。

- **失败判定（请求驱动）**：router 选节点时对目标节点实时探测 `GET /__health`（3s 超时），isolate 内存缓存使用非对称 TTL（活 30s / 死 15s）。探测不通时并行探测其余节点，按排序取第一个活的立即切换；全灭最坏约 6s。
- **转移（sticky）**：按节点 `sort_order` 从当前节点位置依次往下（到末尾回绕）挑第一个存活的节点，并把该故障节点关联的所有 emby 的 `node_id` 定向 UPDATE 为新节点（`home_node_id` 不动）。转移可能连锁发生多次。
- **兜底（也持久化）**：全部节点不健康 → 307 直连 emby 的 `backend_url`，并把不健康节点关联的所有 emby 的 `node_id` UPDATE 为 `''`（直连）；探活周期负责恢复。
- **本地代理**：`node_id = 'local'` 是哨兵值，表示 Worker 本地代理，不参与故障转移/探活。本地代理会隐藏客户端真实 IP，并对后端 302 / PlaybackInfo / M3U8 切片里的绝对 URL 做同源/跨域改写：同源改写为名称形式 `/emby/<name>/path`，跨域（CDN 直链）改写为编码地址形式 `/emby/<encodeURIComponent(url)>`。静态资源走 CF 边缘缓存（cacheEverything 86400s + `Cache-Control: public`），其余 `no-store`。仅显式配置可用。
- **恢复（failback）**：探活周期发现 `home_node_id` 节点连续两个周期健康（防 flapping）→ 把 `node_id != home_node_id` 的 emby 一次性切回 `home_node_id`。
- **误报防护**：故障转移持久化写库前，会对“不健康”节点实时复核探测一次（`persistIfConfirmedDead`）；节点实际活着则跳过写库，本次请求仍走转移目标，等 cron 自愈。
- 管理端显式设置节点（add/update/batch）会同时写 `node_id` 与 `home_node_id`，即重置故障转移状态。

健康检测：cron 每 5 分钟探活（`wrangler.toml` 的 `crons = ["*/5 * * * *"]`），连续 2 次失败降级 / 1 次成功恢复。节点连续失败 ≥5 次后，30 分钟内只真实探测一次；探测成功后若节点 `applied_version` 落后 `config_meta.version`，会异步补推一次配置。

## Required Environment Variables

### proxy-go 节点

| 变量 | 说明 | 必填 |
|---|---|---|
| `EMBY_SYNC_TOKEN` | 与 cf-worker secret 同值，校验推送鉴权 | 是 |
| `EMBY_PROXY_PORT` | 监听端口 | 否（默认 `8080`） |
| `EMBY_DATA_DIR` | 配置缓存目录 | 否（Go 默认 `./data`；Docker/compose 使用 `/app/data`） |

### cf-worker（wrangler secrets）

`ADMIN_TOKEN`（管理 UI 登录）、`EMBY_SYNC_TOKEN`（推节点用）。可选环境变量 `REFERER_RULES_URL`（`/img` 图片代理的外部 Referer 规则 txt，默认 `https://static.laoz.org/proxy/proxy_prefer.txt`）。

- 地址访问（`/emby/http(s)://...`）与图片代理（`/img`）均无鉴权（token 已移除），等同 open proxy，依赖 Worker 域名不公开；私网/保留地址会被 `isPrivateHost` 拦截（403）。
- `EMBY_SYNC_TOKEN` 在 cf-worker 与所有节点上必须 byte-for-byte 一致，不一致 → 节点 401。
- 不要在 CF 面板加 Plaintext Variables：`wrangler deploy` 会用 `wrangler.toml` 中 `[vars]` 段覆盖明文变量（toml 没声明 = 部署后清空）。所有 token 走 `wrangler secret put`。
- `wrangler.toml` 已锁定 `account_id`（Suyu 账号）与 `name = "emby-proxy"`，不要改。

本地 dev：`cf-worker/.dev.vars`（已 gitignore），与生产 secrets 完全独立。

## Deployment

- **CF Worker**：CF 已关联本 GitHub 仓库（Git 集成），线上 Worker 名为 `emby-proxy`。`cf-worker/**` 改动提交合并到 `main` 推送后，CF 自动触发构建部署，无需手动 `wrangler deploy`。历史上曾有 GitHub Actions 部署链路（worker 名 `tg-toolbox-emby-router`），已移除，不要恢复。
- **分支部署规则**：只有合并到 `main`（或直接在 `main` 上提交）并推送远程才触发 CF 自动部署；非 main 分支推送不会触发自动构建。分支上需要验证线上行为时，可手动 `npx wrangler deploy`（注意会覆盖线上）或去 CF 面板用 Git 集成部署该分支。
- **构建日志**：wrangler OAuth 无 Workers Builds 权限，CLI 查不了构建日志，失败原因去 CF 面板 Workers → emby-proxy → Deployments 查看。
- **D1 migration**：CF 构建不跑 migration，需本地执行（且要在推送部署前跑，避免新代码 SELECT 新列失败）：
  ```bash
  cd cf-worker && CLOUDFLARE_ACCOUNT_ID=9a2c5f84e3346b4d2310792e4f759881 npx wrangler d1 migrations apply emby-proxy --remote
  ```
  `CLOUDFLARE_ACCOUNT_ID` 必须显式给：`d1 migrations` 子命令不读 `wrangler.toml` 的 `account_id`（wrangler 3.x），多账号下会报 “More than one account available”。本地若报 `7403`，先跑一次 `npx wrangler whoami` 刷新 OAuth token 再重试。
- **Go 节点**：使用 Agent 调用 `ops` subagent 执行，机器信息以 ops agent 为准。

### 部署后验证

1. **CF Worker**：`cd cf-worker && npx wrangler deployments list | head -20` → 确认最新 deployment 时间与本次推送吻合。
2. **Go 节点**：`curl -s http://<host>:8080/__health` → 确认返回 `{"ok":true,...}`；`docker logs --tail 5 <container>` → 确认无启动错误。
3. **地址访问 / 图片代理**：`curl -s -o /dev/null -w "%{http_code}" https://<worker>/emby/https://example.com/` → 返回后端状态码（本地代理回传，如 `200`）；`curl -s -o /dev/null -w "%{http_code}" "https://<worker>/img?url=https://httpbingo.org/image/png"` → `200`。
4. **面板验证**：`https://<worker>/emby/admin` → 节点列表应有“默认”标记，新增 emby 记录。

## Image Cache

图片缓存功能已注释禁用，图片/视频统一走节点 307 代理。代码保留在 `router.ts` 中，仅注释掉调用点；恢复只需取消注释两处 `isCacheableImageRequest` / `serveCachedImage` 调用。

## Diagnostics

| # | 目标 | 命令 |
|---|---|---|
| 1 | 节点日志（dash） | `ssh -i ~/.ssh/syu_vps -p 22 admin@dash.127315.xyz 'sudo docker logs --tail 100 proxy-go-emby-proxy-1'` |
| 2 | Worker 实时日志 | `cd cf-worker && npx wrangler tail --format pretty` |
| 3 | D1 数据（无 KV，全在 D1） | `cd cf-worker && CLOUDFLARE_ACCOUNT_ID=9a2c5f84e3346b4d2310792e4f759881 npx wrangler d1 execute emby-proxy --remote --json --command "SELECT * FROM embys"`（表：`nodes` / `embys` / `health` / `config_meta`） |
