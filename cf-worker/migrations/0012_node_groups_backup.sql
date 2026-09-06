-- 组内节点角色：0=主成员 1=备用节点。
-- 备用仅在组内主成员全部失效（存活探测为空 / disabled）时启用，不参与常规负载；
-- 只影响 Worker 侧路由决策，不进 sync 协议（节点 snapshot 仍是 path_prefix/backend_url），故不 bump version。
ALTER TABLE node_groups ADD COLUMN is_backup INTEGER NOT NULL DEFAULT 0;
