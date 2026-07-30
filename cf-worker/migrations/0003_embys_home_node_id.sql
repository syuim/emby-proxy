-- 故障转移持久化：node_id 表示「当前生效节点」，home_node_id 记录「原始配置节点」。
-- 探活恢复时以 home_node_id 为准切回，避免多次转移后丢失原始配置。
ALTER TABLE embys ADD COLUMN home_node_id TEXT NOT NULL DEFAULT '';
UPDATE embys SET home_node_id = node_id;
