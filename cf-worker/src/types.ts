export interface NodeRecord {
  id: string;
  name: string;
  public_url: string;
  created_at: string;
  // 排序序号，故障转移按此顺序依次往下选择
  sort_order: number;
}

export interface NodesKV {
  nodes: NodeRecord[];
}

export interface EmbyRecord {
  name: string;
  backend_url: string;
  // 当前生效节点（故障转移时会被改写）
  node_id: string;
  // 原始配置节点（恢复机制的切回目标，仅显式配置时更新）
  home_node_id: string;
  created_at: string;
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
