-- 节点排序：故障转移按 sort_order 依次往下选择
ALTER TABLE nodes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE nodes SET sort_order = (
  SELECT COUNT(*) FROM nodes AS n2 WHERE n2.id < nodes.id
);
