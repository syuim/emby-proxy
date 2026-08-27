-- is_default 列已被 sort_order（0004）取代，移除遗留列。
-- SQLite 无法直接 DROP COLUMN，采用整表重建（先例：0002_embys_drop_node_fk.sql）。

CREATE TABLE nodes_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  public_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT INTO nodes_new (id, name, public_url, created_at, sort_order)
  SELECT id, name, public_url, created_at, sort_order FROM nodes;

DROP TABLE nodes;

ALTER TABLE nodes_new RENAME TO nodes;
