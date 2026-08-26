-- 全局代理模式：节点选择从 per-emby 迁移为 config_meta 全局存储
ALTER TABLE config_meta ADD COLUMN proxy_mode TEXT NOT NULL DEFAULT 'node';
ALTER TABLE config_meta ADD COLUMN active_node_id TEXT NOT NULL DEFAULT '';

-- 迁移现有第一个有效 node_id 到 active_node_id
UPDATE config_meta SET active_node_id = (
  SELECT node_id FROM embys
  WHERE node_id != 'local' AND node_id != ''
  ORDER BY name LIMIT 1
) WHERE id = 1;

-- proxy_mode 默认 'node'
UPDATE config_meta SET proxy_mode = 'node' WHERE id = 1;