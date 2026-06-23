export interface NodeRecord {
  id: string;
  name: string;
  public_url: string;
  created_at: string;
}

export interface NodesKV {
  nodes: NodeRecord[];
}

export interface EmbyRecord {
  name: string;
  backend_url: string;
  node_id: string;
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
}

export interface Env {
  EMBY_KV: KVNamespace;
  ADMIN_TOKEN: string;
  EMBY_SYNC_TOKEN: string;
}
