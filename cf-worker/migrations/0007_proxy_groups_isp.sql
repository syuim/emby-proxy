-- ISP 感知代理组：emby 绑定组后，组内按入口网络（ct/cu/cm）过滤 node 随机负载均衡。
-- 组/ISP 标签只影响 Worker 侧路由决策，不进入 sync 协议（节点 snapshot 仍只有
-- path_prefix/backend_url），故本 migration 不需要 bump config_meta.version。

-- nodes：适合的网络标签，JSON 字符串数组（'["ct","cu"]'）；'[]' = 未标注（任何网络可选）
ALTER TABLE nodes ADD COLUMN isp_tags TEXT NOT NULL DEFAULT '[]';

-- 代理组
CREATE TABLE IF NOT EXISTS proxy_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- node ↔ 组 多对多。不加外键（与 embys/nodes 风格一致），引用由应用层维护
CREATE TABLE IF NOT EXISTS node_groups (
  node_id TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  PRIMARY KEY (node_id, group_id)
);

-- emby 绑定的代理组；NULL = 未绑定（走全局 node 模式逻辑）
ALTER TABLE embys ADD COLUMN group_id INTEGER;
