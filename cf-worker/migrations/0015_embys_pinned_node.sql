-- 指定节点：非空时 node 模式下该 emby 直接 307 到指定节点（优先于代理组与 overseas 直连判定）。
-- 节点不可用时由路由回落现有逻辑（probeAlive 探活）。仅 Worker 路由使用，
-- 不进 sync 协议（节点 snapshot 仍只有 path_prefix/backend_url），故不 bump version。
ALTER TABLE embys ADD COLUMN pinned_node_id TEXT;
