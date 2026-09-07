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

### 代理组相关（migration 0007 / 0012）

`0007_proxy_groups_isp.sql` 新增：`nodes.isp_tags`（JSON 字符串数组 `["ct","cu","cm"]`，空数组 = 未标注/任何网络可选）、`proxy_groups` 表、`node_groups`（node ↔ 组多对多，无外键，应用层维护）、`embys.group_id`（可空，`NULL` = 未绑定组）。`0012_node_groups_backup.sql` 为 `node_groups` 增加 `is_backup` 列（0 = 主成员，1 = 备用节点；备用仅在组内主成员全部失效时启用，不参与常规负载）。同一 node 不能同时为主成员与备用节点，互斥由 API/UI 层校验；成员变更走全量覆盖（`DELETE FROM node_groups WHERE group_id = ?` + 重插），PUT 只显式传一侧字段时另一侧保持现状。

组/ISP 标签只影响 Worker 侧路由决策，**不进入 sync 协议**（节点 snapshot 仍是 path_prefix/backend_url），因此组 CRUD、成员变更、node isp_tags 编辑、emby 绑定/解绑组均**不 bump version、不 fan-out**。删组时应用层把引用它的 `embys.group_id` 置 NULL；删节点时清理 `node_groups` 关联。

入口网络判定数据在 `cf-worker/src/isp.ts`（CAIDA 2026-08 快照归类 + 撞名核验，国内阿里云/腾讯云 ASN 写死归 ct），输出 ct/cu/cm/overseas：未命中（海外、教育网、广电、二级运营商、无 ASN 等）统一归 overseas，**没有独立的 unknown 类**。节点可标注标签只有 `ct / cu / cm`（`overseas` 已废弃，历史行惰性失效——不匹配任何入口，编辑保存即清除）；overseas 入口由 router 直接 307 到 emby 后端，不经节点。表更新时替换该文件三个 ASN Set 即可。

## URL Namespace & Naming Rules

一级路径按功能划分（硬切换，无旧路径兼容）：

- `/emby/<name>/path`：名称访问，node 模式下绑组走组路由、未绑组 Worker local；local/direct 全局模式按模式处理
- `/emby/http(s)://...`：地址访问（原样或 URL 编码），必走本地代理，无鉴权
- `/emby/admin`：管理 UI / API
- `/tmdb/...`：TMDB 反代（一级命名空间，逻辑同原 `/emby/tmdb`）。GET 且路径以 `/t/p/` 开头（TMDB 图片固定结构）时转发到 `image.tmdb.org` 并复用 `/url` 通用代理（UA 伪装 + 目标头规则 + 图片缓存），其余路径转发到 `api.themoviedb.org`
- `/url`：通用 URL 代理，无鉴权（原 `/img` 已并入，`urlproxy.ts` 单一实现），可代理任意 http(s) 资源。仅 `image/*` 且 2xx 响应走 Cache API 缓存（7 天），API/JSON 每次回源并返回 `no-store`；目标请求头（Referer/Origin 等）按内置规则 + 外部 Referer 规则文件自动补齐（防盗链/鉴权，如 gofans API 需注入 `Origin: https://gofans.cn`）
- `/doubanapi/...`：豆瓣简化版 API **别名入口**（无独立后端实现）。内部固定按 emby 记录 `douban`（D1 中 backend=`http://rn.127315.xyz:4000`，绑 US 组）走 `routeNameAccess` 统一名称访问链路——node 模式按入口 ASN 选节点分发、overseas 直连后端、local/direct 全局模式照常；OPTIONS 预检由 Worker 直接应答（浏览器 addon 依赖），客户端 URL 保持不变。仅 JSON catalog 无 body 改写，无鉴权
- 根路径 `/` 302 到 `/emby/admin`；`/__health` 保留在顶层；其余一级路径 404

节点协议路径不含 `/emby` 前缀：307 到节点仍是 `/<name>/subpath`。只有两种访问形式：名称访问 `/emby/<name>/path`（node 模式下绑组走组节点、未绑组 Worker local），地址访问 `/emby/http(s)://...`（原样或 URL 编码）必走本地代理；不存在 `/emby/<name>/<url>` 形式。

地址访问原样形式会自动注册 emby，`node_id`/`home_node_id` 固定为 `local`，只写 emby 记录、不 bump version、不 fan-out 推节点（否则 cron 会误判补推）；编码形式是本地代理改写的回流产物，不触发注册。URL 自带 query（CDN 签名）与外层 query 会合并。地址访问与通用代理均无鉴权，等同 open proxy，依赖域名不公开。

## Failover Behavior

代理模式是全局配置（`config_meta.proxy_mode`，管理 UI 顶部切换）：`node` / `local`（Worker 代理）/ `direct`（直连）。**节点只通过代理组使用**：node 模式下绑组 emby 走代理组路由，未绑组 emby 直接 Worker local（不探测任何节点）。全局节点选择 / `active_node_id` / 故障转移机制已移除（migration 0008 删除 `config_meta.active_node_id` 列）。`embys.node_id` 仅保留一个用途：`'local'` 标记自动注册的 d_xxx emby（地址访问回流产物，始终强制 Worker 本地代理，不受全局模式影响）。

- **绑组 emby（node 模式）**：入口为 overseas（海外/不可判 ASN）时**先于组路由直接 307 直连 emby 后端**（日志 `mode=direct reason=isp-overseas`，等同全局 direct 语义，不经节点）；国内入口（ct/cu/cm）组内每请求并发存活探测（`probeAlive`，复用 30s/15s 非对称 TTL 缓存），按入口 ISP 过滤后随机 307 到节点；主成员全部失效（含禁用）**或存活但均无法匹配入口网络**时启用备用节点池（同样探测 + ISP 过滤后随机）；备用也无可选/组不存在/无主无备 → Worker local 兜底。
- **未绑组 emby（node 模式）**：直接 Worker local（日志 `mode=local reason=no-group`）。
- **本地代理**：Worker 直接 fetch 后端回传，隐藏客户端真实 IP，并对后端 302 / PlaybackInfo / M3U8 切片里的绝对 URL 做同源/跨域改写：同源改写为名称形式 `/emby/<name>/path`，跨域（CDN 直链）改写为编码地址形式 `/emby/<encodeURIComponent(url)>`。静态资源走 CF 边缘缓存（cacheEverything 86400s + `Cache-Control: public`），其余 `no-store`。
- 全局模式切换（PUT `/admin/api/config`）只改 `config_meta.proxy_mode`，不写 `embys` 表，也不 bump version / fan-out（节点 snapshot 只含 path_prefix/backend_url，与模式无关）。

### 代理组路由（per-emby，仅 node 模式下生效）

`proxy_mode = 'node'` 且 `embys.group_id` 非空时，该 emby 走组路由（`src/group.ts`，`chooseNodeFromGroup`）；未绑组 emby 直接 Worker local：

0. **overseas 入口先行直连**：入口网络判定为 overseas（海外/不可判 ASN）时，不探测不选节点，直接 307 到 emby 后端（日志 `mode=direct reason=isp-overseas`，等同全局 direct 语义）。节点标签无 overseas，此分支在 `chooseNodeFromGroup` 内也有防御（直接返回 null）。
1. 取组内 node：主成员（`is_backup=0`）与备用节点（`is_backup=1`）分开成两级池；两池皆空 → Worker local 兜底。
2. 两级池节点一次性**并发存活探测**（`probeAlive`，复用 30s/15s 非对称 TTL 缓存），得存活集合。
3. **入口网络判定**：`request.cf.asn` 查 `isp.ts` 表（未命中用 `asOrganization` 强关键字二次兜底），输出 ct/cu/cm/overseas（overseas 含海外与不可判 ASN；无独立 unknown）。
4. **主池选择**：主成员存活且匹配入口网络（node 无标签 = 全兼容）→ 纯随机 307（日志 `stage=primary`）。
5. **主池不可用 → 备用池**：主池无主成员 / 全部失效（含禁用）/ 存活但均无网络匹配时，对备用池按同规则（存活 + ISP 过滤）选择 → 命中 307（日志 `stage=backup`）。
6. **两级均无网络匹配**（仅 ct/cu/cm 入口能到达此步）：从主∪备全部存活中随机错配兜底（日志 `stage=fallback`，宁可错配不断流）。
7. **全灭兜底**：两级池均无存活 node → Worker local 代理兜底。cron 探活本就全量探测所有 node（与组无关），health 表天然覆盖组内主备成员。

全局模式（local/direct）优先于组：绑组 emby 在全局 local/direct 下仍走全局语义。

健康检测：cron 每 5 分钟探活（`wrangler.toml` 的 `crons = ["*/5 * * * *"]`），连续 2 次失败降级 / 1 次成功恢复。节点连续失败 ≥5 次后，30 分钟内只真实探测一次；探测成功后若节点 `applied_version` 落后 `config_meta.version`，会异步补推一次配置。

## Required Environment Variables

### proxy-go 节点

| 变量 | 说明 | 必填 |
|---|---|---|
| `EMBY_SYNC_TOKEN` | 与 cf-worker secret 同值，校验推送鉴权 | 是 |
| `EMBY_PROXY_PORT` | 监听端口 | 否（默认 `8080`） |
| `EMBY_DATA_DIR` | 配置缓存目录 | 否（Go 默认 `./data`；Docker/compose 使用 `/app/data`） |

### cf-worker（wrangler secrets）

`ADMIN_TOKEN`（管理 UI 登录）、`EMBY_SYNC_TOKEN`（推节点用）。可选环境变量 `REFERER_RULES_URL`（`/url` 通用代理的外部 Referer 规则 txt，默认 `https://static.laoz.org/proxy/proxy_prefer.txt`）。

- 地址访问（`/emby/http(s)://...`）与通用代理（`/url`）均无鉴权（token 已移除），等同 open proxy，依赖 Worker 域名不公开；私网/保留地址会被 `isPrivateHost` 拦截（403）。
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
- **Go 节点**：使用 Agent 调用 `ops` subagent 执行，机器信息以 ops agent 为准。镜像由 GitHub Actions 自动构建推送 `ghcr.io/syuim/emby-proxy:latest`（`.github/workflows/docker-image.yml`，`proxy-go/**` 变更触发，公共镜像无需登录）；节点部署只拉镜像：`docker compose pull && docker compose up -d`（配 watchtower 的机器可自动更新）。容器以非 root（uid 10001）运行，`./data` volume 宿主目录属主需与 uid 10001 匹配（`chown -R 10001:10001 ./data`），否则节点无法落盘配置。

### 部署后验证

1. **CF Worker**：`cd cf-worker && npx wrangler deployments list | head -20` → 确认最新 deployment 时间与本次推送吻合。
2. **Go 节点**：`curl -s http://<host>:8080/__health` → 确认返回 `{"ok":true,...}`；`docker logs --tail 5 <container>` → 确认无启动错误。
3. **地址访问 / 通用代理**：`curl -s -o /dev/null -w "%{http_code}" https://<worker>/emby/https://example.com/` → 返回后端状态码（本地代理回传，如 `200`）；`curl -s -o /dev/null -w "%{http_code}" "https://<worker>/url?url=https://httpbingo.org/image/png"` → `200`。
4. **面板验证**：`https://<worker>/emby/admin` → 节点列表应有“默认”标记，新增 emby 记录。

## Image Cache

图片缓存已移除（2026-08 清理死代码），图片/视频统一走节点 307 代理。图片缓存能力由 `/url` 通用代理承担（`image/*` 且 2xx 走 Cache API 缓存 7 天）。如需恢复本地代理的图片缓存，可从 git 历史找回 `serveCachedImage` / `buildImageCacheKey`。

## Diagnostics

| # | 目标 | 命令 |
|---|---|---|
| 1 | 节点日志（dash） | `ssh -i ~/.ssh/syu_vps -p 22 admin@dash.127315.xyz 'sudo docker logs --tail 100 proxy-go-emby-proxy-1'` |
| 2 | Worker 实时日志 | `cd cf-worker && npx wrangler tail --format pretty` |
| 3 | D1 数据（无 KV，全在 D1） | `cd cf-worker && CLOUDFLARE_ACCOUNT_ID=9a2c5f84e3346b4d2310792e4f759881 npx wrangler d1 execute emby-proxy --remote --json --command "SELECT * FROM embys"`（表：`nodes` / `embys` / `health` / `config_meta`） |
