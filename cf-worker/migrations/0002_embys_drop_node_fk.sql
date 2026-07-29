-- 直连模式用 node_id='' 表示「不经过代理」，但 0001 里 embys.node_id 带
-- FOREIGN KEY REFERENCES nodes(id)，'' 非 NULL 所以外键照样校验且匹配不到任何节点
-- → 任何写入直连 emby 的操作都会 FOREIGN KEY constraint failed。
-- 节点引用的有效性已由应用层保证（checkNodeRefs 校验存在性，删节点时先解引用），
-- 故重建 embys 去掉该外键。SQLite 无法直接 DROP CONSTRAINT，只能整表重建。

CREATE TABLE embys_new (
  name TEXT PRIMARY KEY,
  backend_url TEXT NOT NULL,
  node_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

INSERT INTO embys_new (name, backend_url, node_id, created_at)
  SELECT name, backend_url, node_id, created_at FROM embys;

DROP TABLE embys;

ALTER TABLE embys_new RENAME TO embys;
