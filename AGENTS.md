# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## 双子项目

- **Go 1.22 反代节点**（`proxy-go/`）：接收 cf-worker 推送的 emby 配置，反代 `/<emby_name>/...`
- **CF Worker 控制面**（`cf-worker/`）：客户端入口，管理 UI、307 路由、健康检测、写后 fan-out

## 改完代码必须跑

```bash
cd proxy-go && go test ./...             # 改了 proxy-go/ 才跑
cd cf-worker && npx tsc --noEmit         # 改了 cf-worker/ 才跑
```

## 提交信息

中文 conventional commit，格式 `<type>: <中文描述>`，例：
- `fix: SSRF 防护放宽，允许 CDN 跨域重定向`
- `refactor: 去除 Go proxy 磁盘缓存机制`

正文按需含：问题/需求描述、修复或实现思路、复现路径。

## 排查问题

- ❌ 不靠假设，✅ 必须有日志/数据支撑后再修
- 🚫 严禁未定位根因就开始改代码

## 必需环境变量

- proxy-go 节点：`EMBY_SYNC_TOKEN`（与 cf-worker secret 同值）
- cf-worker：wrangler secrets `ADMIN_TOKEN`、`EMBY_SYNC_TOKEN`

## 协议契约（不可破坏）

cf-worker → 节点 `/admin/sync` 推送 payload 用旧 schema：

```json
{"version": <int>, "proxies": [{"path_prefix": "<emby_name>", "backend_url": "..."}]}
```

字段名 `path_prefix` 是历史名字，对应 worker 内部 `emby_name`。Bearer 头 `Authorization: Bearer $EMBY_SYNC_TOKEN`。

## 沟通

- 中文回复，言简意赅，巧用 Emoji ✨
- 多条数据**用表格 + 序号**
- 复杂任务先用 Plan Mode 规划，简单改动直接动手
- 多任务时优先 Subagent 并发
