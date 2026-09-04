-- 全局节点选择已移除（节点只通过代理组使用，未绑组直接 Worker local），
-- active_node_id 已无任何读写方，删除该列。
ALTER TABLE config_meta DROP COLUMN active_node_id;
