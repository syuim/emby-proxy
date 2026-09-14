-- Telegram 通知：配置存 config_meta 单行（管理 UI 配置 tab 读写）；
-- seen_ips 记录已通知过的客户端 IP（D1 为唯一真源，跨 isolate 去重）
ALTER TABLE config_meta ADD COLUMN tg_bot_token TEXT NOT NULL DEFAULT '';
ALTER TABLE config_meta ADD COLUMN tg_chat_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS seen_ips (
  ip TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_seen_ips_first_seen ON seen_ips(first_seen);
