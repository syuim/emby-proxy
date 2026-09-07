export interface NodeRecord {
  id: string;
  name: string;
  public_url: string;
  created_at: string;
  // 适合的网络标签（'ct' 电信 / 'cu' 联通 / 'cm' 移动），空数组 = 任何网络可选；
  // 海外/未知 ASN 入口不经节点，直接 307 到后端（见 router.ts），故无 overseas 标签
  isp_tags: string[];
  // 手动禁用：视为不可达，不参与组路由 / 探活 / 配置推送
  disabled: boolean;
}

export interface NodesKV {
  nodes: NodeRecord[];
}

export interface ProxyGroup {
  id: number;
  name: string;
  created_at: string;
}

export interface ProxyGroupWithMembers extends ProxyGroup {
  node_ids: string[];
  // 备用节点：组内主成员全部失效时才启用，不参与常规负载
  backup_node_ids: string[];
}

export interface EmbyRecord {
  name: string;
  backend_url: string;
  created_at: string;
  // 绑定的代理组；null = 未绑定（node 模式下直接 Worker local）
  group_id: number | null;
}

export interface EmbysKV {
  version: number;
  embys: EmbyRecord[];
}

export interface NodeHealth {
  healthy: boolean;
  last_check: string | null;
  consecutive_fails: number;
  last_latency_ms: number | null;
  applied_version: number | null;
  last_sync_error: string | null;
  backend_latencies?: Record<string, number | null>;
}

export interface HealthKV {
  updated_at: string;
  nodes: Record<string, NodeHealth>;
}

export interface SyncSnapshot {
  version: number;
  proxies: { path_prefix: string; backend_url: string }[];
}

export interface ConfigMeta {
  proxy_mode: 'node' | 'local' | 'direct';
  version: number;
}

export interface PushResult {
  node_id: string;
  status: "ok" | "error";
  http_status?: number;
  error?: string | null;
  applied_version?: number | null;
}

export interface Env {
  EMBY_DB: D1Database;
  ADMIN_TOKEN: string;
  EMBY_SYNC_TOKEN: string;
  // /url 通用代理外部 Referer 规则文件 URL（可选，覆盖内置默认）
  REFERER_RULES_URL?: string;
}
