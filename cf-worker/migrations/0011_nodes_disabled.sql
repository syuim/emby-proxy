-- 节点手动禁用：禁用后视为不可达（组路由/探活/配置推送全跳过），用于下线维护等场景。
-- 只影响 Worker 侧决策，不进 sync 协议（节点 snapshot 仍是 path_prefix/backend_url），故不 bump version。
ALTER TABLE nodes ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
