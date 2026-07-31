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

## URL 命名空间与命名规则

一级路径按功能划分（**硬切换，无旧路径兼容**）：emby 相关全部挂在 `/emby/...` 下——`/emby/<name>/path`（名称访问）、`/emby/http(s)://...`（地址访问，原样或 URL 编码，无鉴权）、`/emby/tmdb/...`（TMDB 反代）、`/emby/admin`（管理 UI/API）；`/img` 为通用图片代理（见下）。根路径 `/` 302 到 `/emby/admin`，`/__health` 保留在顶层；其余一级路径 404。

**节点协议路径不含 `/emby` 前缀**：307 到节点仍是 `/<name>/subpath`（proxy-go 契约不变，节点的 `/admin/sync` 也与此无关）。

不能作为 `emby_name` 的保留字：`admin / api / health / __health / favicon.ico / robots.txt / .well-known / _ / tmdb`。

`emby_name` 还需满足正则 `^[a-zA-Z0-9_-]{1,32}$`，加新 emby 或写测试时避开上述约束。

## 故障转移行为

`embys` 有两个节点字段：`node_id` = 当前生效节点（故障转移会改写），`home_node_id` = 原始配置节点（只有显式改配置才更新，是恢复切回的目标）。

- **失败判定（请求驱动）**：router 选节点时对目标节点实时探测 `GET /__health`（3s 超时），isolate 内存缓存**非对称 TTL**（活 30s / 死 15s）。探测不通并行探测其余节点，按排序取第一个活的立即切换（全灭最坏 ~6s：主节点超时 3s + 并行探测 3s），**不依赖 cron 探活周期**。cron 探活仍负责 failback/救援判定与配置补推。
- **转移（sticky）**：emby 的 `node_id` 探测不通 → router 按节点 `sort_order` 排序，从当前节点位置**依次往下**（到末尾回绕）挑第一个探测存活的，并把该故障节点关联的**所有 emby** 的 `node_id` 定向 UPDATE 为新节点（`home_node_id` 不动），后续请求直接命中新节点。转移可能连锁发生多次。节点排序在管理 UI 节点页用 ↑/↓ 调整（`POST /admin/api/nodes/reorder`）。
- **兜底（也持久化）**：全部节点不健康 → 307 直连 emby 的 `backend_url`（不返 503），并把该不健康节点关联的所有 emby 的 `node_id` UPDATE 为 `''`（直连），后续请求不再逐个探健康；探活周期负责恢复：home 恢复 → 切回；home 未恢复但有其他健康节点 → 按排序转移过去。
- **本地代理**：`node_id = 'local'` 是哨兵值（非真实节点），表示 Worker 本地代理——不 307，Worker 全程中转，客户端只见 Worker 域名。IP 透传固定 strict：抹 CF/代理头、Origin/Referer 对齐后端、透传 X-Real-IP/X-Forwarded-For。改写规则：后端 302 / PlaybackInfo（`DirectStreamUrl`/`TranscodingUrl`）/ M3U8 切片里的绝对 URL，**同源**改写为名称形式 `/emby/<name>/path`，**跨域**（CDN 直链）改写为编码地址形式 `/emby/<encodeURIComponent(url)>`。静态资源走 CF 边缘缓存（cacheEverything 86400s + `Cache-Control: public`），其余 `no-store`。仅显式配置可用，不参与故障转移/探活。
- **只有两种访问形式**：名称访问 `/emby/<name>/path` → 走节点选择（local 亦在其中）；地址访问 `/emby/http(s)://...`（原样或 URL 编码）→ **必走本地代理**。不存在 `/emby/<name>/<url>` 形式。**原样形式**（用户粘贴）会自动注册 emby（有节点分配默认节点，无节点注册为直连）；**编码形式**是本地代理改写的回流产物（多为 CDN 直链），不触发注册，避免刷表。URL 自带 query（CDN 签名）与外层 query 会合并。**无鉴权**，等同 open proxy，依赖域名不公开。
- **恢复（failback，带冷却期）**：探活周期发现 `home_node_id` 节点**连续两个周期**健康（防 flapping 反复切）→ 把 `node_id != home_node_id` 的 emby 一次性切回 `home_node_id`。多次转移后仍恢复到**原始配置节点**，而非上一次的临时节点。
- **误报防护**：故障转移持久化写库前，会对「不健康」节点实时复核探测一次（`persistIfConfirmedDead`）；节点实际活着（health 表过期/误报）则跳过写库，本次请求仍走转移目标，等 cron 自愈。
- 管理端显式设置节点（add/update/batch）会同时写 `node_id` 与 `home_node_id`，即重置故障转移状态。

健康检测：cron 每 10 分钟探活，连续 2 次失败降级 / 1 次成功恢复。

探活降频：节点连续失败 ≥5 次后，30 分钟内只真实探测一次，避免反复打已知死节点。探测成功后若节点 `applied_version` 落后 KV，会异步补推一次配置。

## 必需环境变量

### proxy-go 节点

| 变量 | 说明 | 必填 |
|---|---|---|
| `EMBY_SYNC_TOKEN` | 与 cf-worker secret 同值，校验推送鉴权 | 是 |
| `EMBY_PROXY_PORT` | 监听端口 | 否（默认 `8080`） |
| `EMBY_DATA_DIR` | 配置缓存目录 | 否（Go 默认 `./data`；Docker/compose 使用 `/app/data`） |

### cf-worker（wrangler secrets）

`ADMIN_TOKEN`（管理 UI 登录）、`EMBY_SYNC_TOKEN`（推节点用）。可选环境变量 `REFERER_RULES_URL`（/img 图片代理的外部 Referer 规则 txt，默认 `https://static.laoz.org/bot/proxy_prefer.txt`）。

- 地址访问（`/emby/http(s)://...`）与图片代理（`/img`）**均无鉴权**（token 已移除），等同 open proxy，依赖 Worker 域名不公开；私网/保留地址会被 `isPrivateHost` 拦截（403）。

**关键约束**：
- `EMBY_SYNC_TOKEN` 在 cf-worker 与所有节点上必须 **byte-for-byte** 一致，不一致 → 节点 401
- ⚠️ **不要在 CF 面板上加 Plaintext Variables**：`wrangler deploy` 会用 `wrangler.toml` 中 `[vars]` 段覆盖明文变量（toml 没声明 = 部署后清空）。所有 token 走 `wrangler secret put`
- `wrangler.toml` 已锁定 `account_id`（Suyu 账号）与 `name = "emby-proxy"`，不要改

本地 dev：`cf-worker/.dev.vars`（已 gitignore），与生产 secrets 完全独立。

## 图片缓存（已禁用）

图片缓存功能已注释禁用，图片/视频统一走节点 307 代理。代码保留在 `router.ts` 中，仅注释掉调用点，恢复只需取消注释两处 `isCacheableImageRequest`/`serveCachedImage` 调用。

## 部署

- **CF Worker**：CF 已关联本 GitHub 仓库（Git 集成），线上 Worker 名为 **`emby-proxy`**（与 `wrangler.toml` 的 `name` 一致）——`cf-worker/**` 做完改动后 → 提交合并到 `main` 推送 GitHub，**CF 自动触发构建部署**，无需手动 `wrangler deploy`。直接说"部署"或"合并到 main"即可，不需要问。历史上曾有 GitHub Actions 部署链路（worker 名 `tg-toolbox-emby-router`），已移除，不要恢复。
- **构建日志**：wrangler OAuth 无 Workers Builds 权限，CLI 查不了构建日志，失败原因去面板 Workers → emby-proxy → Deployments 看。CLI 只能用 `npx wrangler deployments list` 核对部署时间。
- **D1 migration**：**CF 构建不跑 migration**，需本地执行（且要在推送部署前跑，避免新代码 SELECT 新列失败）：
  ```bash
  cd cf-worker && CLOUDFLARE_ACCOUNT_ID=9a2c5f84e3346b4d2310792e4f759881 npx wrangler d1 migrations apply emby-proxy --remote
  ```
  - `CLOUDFLARE_ACCOUNT_ID` 必须显式给：`d1 migrations` 子命令**不读 `wrangler.toml` 的 `account_id`**（wrangler 3.x），多账号下会报 "More than one account available"。
  - 本地若报 `7403`，先跑一次 `npx wrangler whoami` 刷新 OAuth token 再重试。
- **Go 节点**：使用 `Agent` 调用 `ops` subagent 执行，机器信息以 ops agent 为准。

### 部署后验证

1. **CF Worker**：`cd cf-worker && npx wrangler deployments list | head -20` → 确认最新 deployment 时间与本次推送吻合（CF Git 集成自动构建）
2. **Go 节点**：`curl -s http://<host>:8080/__health` → 确认返回 `{"ok":true,...}`；`docker logs --tail 5 <container>` → 确认无启动错误
3. **地址访问 / 图片代理**：`curl -s -o /dev/null -w "%{http_code}" https://<worker>/emby/https://example.com/` → 返回后端状态码（本地代理回传，如 `200`）；`curl -s -o /dev/null -w "%{http_code}" "https://<worker>/img?url=https://httpbingo.org/image/png"` → `200`
4. **面板验证**：`https://<worker>/emby/admin` → 节点列表应有"默认"标记，新增 emby 记录

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
