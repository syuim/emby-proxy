import {
  FAIL_THRESHOLD,
  HEALTH_PROBE_TIMEOUT_MS,
  NODE_HEALTH_PATH,
  STATUS_PATH,
} from "./constants";
import {
  emptyNodeHealth,
  readEmbys,
  readHealth,
  readNodes,
  writeHealth,
} from "./storage";
import { buildSnapshot, pushSnapshotToNode } from "./sync";
import type {
  EmbysKV,
  Env,
  HealthKV,
  NodeHealth,
  NodeRecord,
  PushResult,
} from "./types";

interface ProbeOutcome {
  node: NodeRecord;
  ok: boolean;
  latency_ms: number | null;
  error: string | null;
  applied_version: number | null;
}

export async function runHealthCycle(
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const [nodesKV, embysKV, prevHealth] = await Promise.all([
    readNodes(env),
    readEmbys(env),
    readHealth(env),
  ]);

  if (nodesKV.nodes.length === 0) {
    await writeHealth(env, { updated_at: new Date().toISOString(), nodes: {} });
    return;
  }

  const outcomes = await Promise.all(
    nodesKV.nodes.map((n) => probeNode(n, env.EMBY_SYNC_TOKEN)),
  );

  const newHealth: HealthKV = {
    updated_at: new Date().toISOString(),
    nodes: {},
  };
  for (const o of outcomes) {
    const prev = prevHealth.nodes[o.node.id] ?? emptyNodeHealth();
    newHealth.nodes[o.node.id] = mergeHealth(prev, o);
  }
  await writeHealth(env, newHealth);

  // 补齐：节点 applied_version 与 KV embys.version 不一致时异步补推
  ctx.waitUntil(
    backfillOutdatedNodes(env, embysKV, nodesKV.nodes, outcomes, newHealth),
  );
}

async function probeNode(
  node: NodeRecord,
  syncToken: string,
): Promise<ProbeOutcome> {
  const base = node.public_url.replace(/\/$/, "");
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(base + NODE_HEALTH_PATH, {
      signal: controller.signal,
    });
    if (!resp.ok) {
      return {
        node,
        ok: false,
        latency_ms: Date.now() - start,
        error: `health HTTP ${resp.status}`,
        applied_version: null,
      };
    }
    const latency = Date.now() - start;

    // 顺带拉一下 status 拿 applied_version（失败不算节点不健康，仅 version 缺失）
    let appliedVersion: number | null = null;
    try {
      const statusResp = await fetch(base + STATUS_PATH, {
        headers: { Authorization: `Bearer ${syncToken}` },
        signal: controller.signal,
      });
      if (statusResp.ok) {
        const data = (await statusResp.json()) as { version?: number };
        appliedVersion = typeof data.version === "number" ? data.version : null;
      }
    } catch {
      // ignore
    }
    return {
      node,
      ok: true,
      latency_ms: latency,
      error: null,
      applied_version: appliedVersion,
    };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      node,
      ok: false,
      latency_ms: null,
      error: msg,
      applied_version: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 慢降级、快恢复：
 * - 连续失败 ≥ FAIL_THRESHOLD 才标 unhealthy
 * - 任意一次成功立即标 healthy
 */
function mergeHealth(prev: NodeHealth, outcome: ProbeOutcome): NodeHealth {
  const now = new Date().toISOString();
  if (outcome.ok) {
    return {
      healthy: true,
      last_check: now,
      consecutive_fails: 0,
      last_latency_ms: outcome.latency_ms,
      applied_version: outcome.applied_version ?? prev.applied_version,
      last_sync_error: prev.last_sync_error,
    };
  }
  const fails = prev.consecutive_fails + 1;
  return {
    healthy: fails < FAIL_THRESHOLD ? prev.healthy : false,
    last_check: now,
    consecutive_fails: fails,
    last_latency_ms: outcome.latency_ms,
    applied_version: prev.applied_version,
    last_sync_error: outcome.error ?? prev.last_sync_error,
  };
}

async function backfillOutdatedNodes(
  env: Env,
  embysKV: EmbysKV,
  nodes: NodeRecord[],
  outcomes: ProbeOutcome[],
  health: HealthKV,
): Promise<void> {
  const targetVersion = embysKV.version;
  if (targetVersion === 0) return;

  const stale = outcomes.filter(
    (o) => o.ok && o.applied_version !== null && o.applied_version !== targetVersion,
  );
  if (stale.length === 0) return;

  const snapshot = buildSnapshot(embysKV);
  const results = await Promise.all(
    stale.map((o) => pushSnapshotToNode(o.node, snapshot, env.EMBY_SYNC_TOKEN)),
  );
  // 把推送结果写回 health.last_sync_error
  await mergeSyncResults(env, health, results, nodes);
}

export async function mergeSyncResults(
  env: Env,
  baseHealth: HealthKV,
  results: PushResult[],
  _nodes: NodeRecord[],
): Promise<void> {
  if (results.length === 0) return;
  const next: HealthKV = {
    updated_at: new Date().toISOString(),
    nodes: { ...baseHealth.nodes },
  };
  for (const r of results) {
    const prev = next.nodes[r.node_id] ?? emptyNodeHealth();
    next.nodes[r.node_id] = {
      ...prev,
      last_sync_error: r.status === "ok" ? null : (r.error ?? "sync error"),
    };
  }
  await writeHealth(env, next);
}
