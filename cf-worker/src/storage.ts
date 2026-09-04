import type {
  ConfigMeta,
  EmbysKV,
  Env,
  HealthKV,
  NodeHealth,
  NodesKV,
  ProxyGroup,
  ProxyGroupWithMembers,
} from "./types";

const EMPTY_NODES: NodesKV = { nodes: [] };
const EMPTY_EMBYS: EmbysKV = { version: 0, embys: [] };
const EMPTY_HEALTH: HealthKV = { updated_at: "", nodes: {} };

function parseIspTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ---------- read ----------

export async function readNodes(env: Env): Promise<NodesKV> {
  const res = await env.EMBY_DB.prepare(
    "SELECT id, name, public_url, created_at, isp_tags, disabled FROM nodes ORDER BY created_at, id",
  ).all<{
    id: string;
    name: string;
    public_url: string;
    created_at: string;
    isp_tags: string | null;
    disabled: number;
  }>();
  if (!res.success || !res.results) return structuredClone(EMPTY_NODES);
  return {
    nodes: res.results.map((r) => ({
      id: r.id,
      name: r.name,
      public_url: r.public_url,
      created_at: r.created_at,
      isp_tags: parseIspTags(r.isp_tags),
      disabled: r.disabled === 1,
    })),
  };
}

export async function readConfigMeta(env: Env): Promise<ConfigMeta> {
  const res = await env.EMBY_DB.prepare(
    "SELECT version, proxy_mode FROM config_meta WHERE id = 1",
  ).first<{ version: number; proxy_mode: string }>();
  if (!res) {
    return { proxy_mode: "node", version: 0 };
  }
  return {
    proxy_mode: (res.proxy_mode as ConfigMeta["proxy_mode"]) || "node",
    version: res.version,
  };
}

export async function readEmbys(env: Env): Promise<EmbysKV> {
  const [embysRes, verRes] = await env.EMBY_DB.batch([
    env.EMBY_DB.prepare(
      "SELECT name, backend_url, group_id, created_at FROM embys ORDER BY name",
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
      group_id: r.group_id ?? null,
      created_at: r.created_at,
    })),
  };
}

export async function readGroups(env: Env): Promise<ProxyGroup[]> {
  const res = await env.EMBY_DB.prepare(
    "SELECT id, name, created_at FROM proxy_groups ORDER BY name, id",
  ).all<{ id: number; name: string; created_at: string }>();
  if (!res.success || !res.results) return [];
  return res.results.map((r) => ({
    id: r.id,
    name: r.name,
    created_at: r.created_at,
  }));
}

export async function readGroupsWithMembers(env: Env): Promise<ProxyGroupWithMembers[]> {
  const [groups, members] = await env.EMBY_DB.batch([
    env.EMBY_DB.prepare(
      "SELECT id, name, created_at FROM proxy_groups ORDER BY name, id",
    ),
    env.EMBY_DB.prepare("SELECT group_id, node_id FROM node_groups"),
  ]);
  const list: ProxyGroupWithMembers[] = (groups.results ?? []).map((r: any) => ({
    id: r.id as number,
    name: r.name as string,
    created_at: r.created_at as string,
    node_ids: [],
  }));
  const byId = new Map(list.map((g) => [g.id, g]));
  for (const m of (members.results ?? []) as { group_id: number; node_id: string }[]) {
    byId.get(m.group_id)?.node_ids.push(m.node_id);
  }
  return list;
}

export async function readGroupNodeIds(env: Env, groupId: number): Promise<string[]> {
  const res = await env.EMBY_DB.prepare(
    "SELECT node_id FROM node_groups WHERE group_id = ?",
  ).bind(groupId).all<{ node_id: string }>();
  if (!res.success || !res.results) return [];
  return res.results.map((r) => r.node_id);
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

export async function writeHealth(
  env: Env,
  value: HealthKV,
  cachedPrev?: HealthKV,
): Promise<void> {
  // 定向 upsert（node_id 主键），只写本周期探测到的节点；
  // 没在本周期的节点（如刚删）由调用方负责清理，避免全表 DELETE + 重插。
  const stmts: D1PreparedStatement[] = [];
  for (const [nodeId, h] of Object.entries(value.nodes)) {
    // 与缓存值无变化则跳过，减少无谓写入
    if (cachedPrev) {
      const prev = cachedPrev.nodes[nodeId];
      if (
        prev &&
        prev.healthy === h.healthy &&
        prev.last_check === h.last_check &&
        prev.consecutive_fails === h.consecutive_fails &&
        prev.last_latency_ms === h.last_latency_ms &&
        prev.applied_version === h.applied_version &&
        prev.last_sync_error === h.last_sync_error &&
        JSON.stringify(prev.backend_latencies ?? null) === JSON.stringify(h.backend_latencies ?? null)
      ) {
        continue;
      }
    }
    stmts.push(
      env.EMBY_DB.prepare(
        `INSERT INTO health(node_id, healthy, last_check, consecutive_fails, last_latency_ms, applied_version, last_sync_error, backend_latencies)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(node_id) DO UPDATE SET
           healthy = excluded.healthy,
           last_check = excluded.last_check,
           consecutive_fails = excluded.consecutive_fails,
           last_latency_ms = excluded.last_latency_ms,
           applied_version = excluded.applied_version,
           last_sync_error = excluded.last_sync_error,
           backend_latencies = excluded.backend_latencies`,
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
  if (stmts.length === 0) return;
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
