# emby-proxy

Emby 反代统一入口，前后端分离架构：

- **CF Worker 控制面**（`cf-worker/`）：客户端入口、管理 UI、路由调度、健康检测、配置 fan-out、本地代理兜底
- **Go 反代节点**（`proxy-go/`）：接收 cf-worker 推送的 emby 配置，反代 `/<emby_name>/...` 到真 Emby 后端

## 文档

**`AGENTS.md` 是唯一权威文档**：架构、URL 命名空间、故障转移、环境变量、部署与验证流程全部以它为准（本 README 不再重复，避免漂移）。

## 开发

```bash
# Go 反代
cd proxy-go && go test ./...

# CF Worker
cd cf-worker && npm run typecheck && npm test
```

## 部署

- CF Worker：Cloudflare Workers Builds（Git 集成），`main` 分支推送自动部署
- Go 节点：`cd proxy-go && docker compose up -d --build`

详见 `AGENTS.md` 的 Deployment 与部署验证流程。
