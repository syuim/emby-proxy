-- embys.node_id/home_node_id 已无路由消费（节点只通过代理组使用），删除历史字段
ALTER TABLE embys DROP COLUMN node_id;
ALTER TABLE embys DROP COLUMN home_node_id;