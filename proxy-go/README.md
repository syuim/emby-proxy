# Emby Reverse Proxy (Go)

aiohttp 反代的 Go 改写，替换 slave 模式 (`python -m src.slave`)。

## 功能

| # | 功能 | 状态 |
|---|------|------|
| 1 | 路径前缀路由 (`/prefix/...` → backend) | ✅ |
| 2 | Hop-by-hop 头过滤 | ✅ |
| 3 | CORS + OPTIONS 204 | ✅ |
| 4 | Set-Cookie Domain/Path 剥离 | ✅ |
| 5 | 服务端重定向跟随（≤5 跳） | ✅ |
| 6 | SSRF 防护（origin + 端口规范化） | ✅ |
| 7 | 301/302 POST→GET 转换 | ✅ |
| 8 | 流式转发 (`io.Copy`) | ✅ |
| 9 | ~~客户端断连检测~~ | ⏭️ 不实现 |
| 10 | `/__health` | ✅ |
| 11 | `/admin/sync` (Bearer auth) | ✅ |
| 12 | `/admin/status` (Bearer auth) | ✅ |
| 13 | JSON 配置持久化（原子写入） | ✅ |

## 编译 & 运行

```bash
# 本地运行
go build -o emby-proxy .
EMBY_SYNC_TOKEN=xxx EMBY_PROXY_PORT=8080 EMBY_DATA_DIR=./data ./emby-proxy

# Docker
docker build -t emby-proxy .
docker run -d -p 8080:8080 \
  -e EMBY_SYNC_TOKEN=xxx \
  -e EMBY_DATA_DIR=/app/data \
  -v ./data:/app/data \
  emby-proxy
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `EMBY_SYNC_TOKEN` | ✅ | — | Master 推送配置的 Bearer Token |
| `EMBY_PROXY_PORT` | — | `8080` | 监听端口 |
| `EMBY_DATA_DIR` | — | `./data` | 配置持久化目录 |

## 与 Python slave 的对比

| 指标 | Python slave | Go proxy |
|------|-------------|----------|
| 镜像大小 | ~150MB (python:3.12-slim) | ~15MB (alpine + 6MB binary) |
| 运行时内存 | ~30-50MB | ~5-10MB |
| 依赖 | aiohttp, feedparser | 无（纯标准库） |
| 启动速度 | ~1s | <100ms |

## 兼容性

与 master 的 `/admin/sync` 协议完全兼容，可直接替换 slave 节点：
- 相同 JSON 格式 (`{version, proxies}`)
- 相同 Bearer Token 认证
- 相同端口和路由

## 测试

```bash
go test -v ./...
```
