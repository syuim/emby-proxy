import type {
  EmbysKV,
  Env,
  HealthKV,
  NodeHealth,
  NodesKV,
} from "./types";

const EMPTY_NODES: NodesKV = { nodes: [] };
const EMPTY_EMBYS: EmbysKV = { version: 0, embys: [] };
const EMPTY_HEALTH: HealthKV = { updated_at: "", nodes: {} };

// ---------- read ----------

export async function readNodes(env: Env): Promise<NodesKV> {
  const res = await env.EMBY_DB.prepare(
    "SELECT id, name, public_url, is_default, created_at FROM nodes ORDER BY id",
  ).all<{
    id: string;
    name: string;
    public_url: string;
    is_default: number;
    created_at: string;
  }>();
  if (!res.success || !res.results) return structuredClone(EMPTY_NODES);
  return {
    nodes: res.results.map((r) => ({
      id: r.id,
      name: r.name,
      public_url: r.public_url,
      is_default: r.is_default === 1,
      created_at: r.created_at,
    })),
  };
}

export async function readEmbys(env: Env): Promise<EmbysKV> {
  const [embysRes, verRes] = await env.EMBY_DB.batch([
    env.EMBY_DB.prepare(
      "SELECT name, backend_url, node_id, created_at FROM embys ORDER BY name",
    ),
    env.EMBY_DB.prepare("SELECT version FROM config_meta WHERE id = 1"),
  ]);
  if (!embysRes.success || !embysRes.results) return structuredClone(EMPTY_EMBYS);
  const version =
    verRes.results && verRes.results.length > 0
      ? (verRes.results[0] as { version: number }).version
      : 0;
  return {
    version,
    embys: embysRes.results.map((r: any) => ({
      name: r.name,
      backend_url: r.backend_url,
      node_id: r.node_id,
      created_at: r.created_at,
    })),
  };
}

export async function readHealth(env: Env): Promise<HealthKV> {
  const res = await env.EMBY_DB.prepare(
    "SELECT node_id, healthy, last_check, consecutive_fails, last_latency_ms, applied_version, last_sync_error, backend_latencies FROM health",
  ).all<{
    node_id: string;
    healthy: number;
    last_check: string | null;
    consecutive_fails: number;
    last_latency_ms: number | null;
    applied_version: number | null;
    last_sync_error: string | null;
    backend_latencies: string | null;
  }>();
  if (!res.success || !res.results) return structuredClone(EMPTY_HEALTH);
  const nodes: Record<string, NodeHealth> = {};
  for (const r of res.results) {
    let latencies: Record<string, number | null> | undefined;
    if (r.backend_latencies) {
      try {
        latencies = JSON.parse(r.backend_latencies) as Record<string, number | null>;
      } catch {
        latencies = undefined;
      }
    }
    nodes[r.node_id] = {
      healthy: r.healthy === 1,
      last_check: r.last_check,
      consecutive_fails: r.consecutive_fails,
      last_latency_ms: r.last_latency_ms,
      applied_version: r.applied_version,
      last_sync_error: r.last_sync_error,
      backend_latencies: latencies,
    };
  }
  return { updated_at: new Date().toISOString(), nodes };
}

// ---------- write ----------

export async function writeNodes(
  env: Env,
  value: NodesKV,
  _cachedPrev?: NodesKV,
): Promise<void> {
  const stmts = [env.EMBY_DB.prepare("DELETE FROM nodes")];
  for (const n of value.nodes) {
    stmts.push(
      env.EMBY_DB.prepare(
        "INSERT INTO nodes(id, name, public_url, is_default, created_at) VALUES(?,?,?,?,?)",
      ).bind(n.id, n.name, n.public_url, n.is_default ? 1 : 0, n.created_at),
    );
  }
  await env.EMBY_DB.batch(stmts);
}

export async function writeEmbys(
  env: Env,
  value: EmbysKV,
  _cachedPrev?: EmbysKV,
): Promise<void> {
  const stmts = [env.EMBY_DB.prepare("DELETE FROM embys")];
  for (const e of value.embys) {
    stmts.push(
      env.EMBY_DB.prepare(
        "INSERT INTO embys(name, backend_url, node_id, created_at) VALUES(?,?,?,?)",
      ).bind(e.name, e.backend_url, e.node_id, e.created_at),
    );
  }
  stmts.push(
    env.EMBY_DB.prepare("UPDATE config_meta SET version = ? WHERE id = 1").bind(
      value.version,
    ),
  );
  await env.EMBY_DB.batch(stmts);
}

export async function writeHealth(
  env: Env,
  value: HealthKV,
  _cachedPrev?: HealthKV,
): Promise<void> {
  const stmts = [env.EMBY_DB.prepare("DELETE FROM health")];
  for (const [nodeId, h] of Object.entries(value.nodes)) {
    stmts.push(
      env.EMBY_DB.prepare(
        "INSERT INTO health(node_id, healthy, last_check, consecutive_fails, last_latency_ms, applied_version, last_sync_error, backend_latencies) VALUES(?,?,?,?,?,?,?,?)",
      ).bind(
        nodeId,
        h.healthy ? 1 : 0,
        h.last_check,
        h.consecutive_fails,
        h.last_latency_ms,
        h.applied_version,
        h.last_sync_error,
        h.backend_latencies ? JSON.stringify(h.backend_latencies) : null,
      ),
    );
  }
  await env.EMBY_DB.batch(stmts);
}

// ---------- helpers ----------

export function emptyNodeHealth(): NodeHealth {
  return {
    healthy: false,
    last_check: null,
    consecutive_fails: 0,
    last_latency_ms: null,
    applied_version: null,
    last_sync_error: null,
  };
}

// ---------- comparison (no longer needed for D1, kept for signature compat) ----------

export function nodesEqual(a: NodesKV, b: NodesKV): boolean {
  if (a.nodes.length !== b.nodes.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    const an = a.nodes[i];
    const bn = b.nodes[i];
    if (
      an.id !== bn.id ||
      an.name !== bn.name ||
      an.public_url !== bn.public_url ||
      !!an.is_default !== !!bn.is_default ||
      an.created_at !== bn.created_at
    ) {
      return false;
    }
  }
  return true;
}

export function embysEqual(a: EmbysKV, b: EmbysKV): boolean {
  if (a.version !== b.version) return false;
  if (a.embys.length !== b.embys.length) return false;
  for (let i = 0; i < a.embys.length; i++) {
    const ae = a.embys[i];
    const be = b.embys[i];
    if (
      ae.name !== be.name ||
      ae.backend_url !== be.backend_url ||
      ae.node_id !== be.node_id ||
      ae.created_at !== be.created_at
    ) {
      return false;
    }
  }
  return true;
}

export function healthEqual(a: HealthKV, b: HealthKV): boolean {
  const aKeys = Object.keys(a.nodes);
  const bKeys = Object.keys(b.nodes);
  if (aKeys.length !== bKeys.length) return false;
  const aSet = new Set(aKeys);
  for (const k of bKeys) {
    if (!aSet.has(k)) return false;
  }
  for (const k of aKeys) {
    const an = a.nodes[k];
    const bn = b.nodes[k];
    if (
      an.healthy !== bn.healthy ||
      an.consecutive_fails !== bn.consecutive_fails ||
      an.last_latency_ms !== bn.last_latency_ms ||
      an.applied_version !== bn.applied_version ||
      an.last_sync_error !== bn.last_sync_error
    ) {
      return false;
    }
  }
  return true;
}
