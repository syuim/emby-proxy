-- sort_order 已无路由/排序用途（节点只通过代理组使用，列表按 created_at 排序）
ALTER TABLE nodes DROP COLUMN sort_order;
