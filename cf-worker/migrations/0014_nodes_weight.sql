-- 节点权重：组路由池内按权重加权随机选择（1~100 整数，默认 1 = 等权）。
-- 只影响 Worker 侧路由决策，不进 sync 协议（节点 snapshot 仍是 path_prefix/backend_url），故不 bump version。
ALTER TABLE nodes ADD COLUMN weight INTEGER NOT NULL DEFAULT 1;
