CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  public_url TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embys (
  name TEXT PRIMARY KEY,
  backend_url TEXT NOT NULL,
  node_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);

CREATE TABLE IF NOT EXISTS config_meta (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
);

INSERT INTO config_meta (id, version) VALUES (1, 0) ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS health (
  node_id TEXT PRIMARY KEY,
  healthy INTEGER NOT NULL DEFAULT 0,
  last_check TEXT,
  consecutive_fails INTEGER NOT NULL DEFAULT 0,
  last_latency_ms INTEGER,
  applied_version INTEGER,
  last_sync_error TEXT,
  backend_latencies TEXT
);
