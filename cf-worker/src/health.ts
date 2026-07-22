import {
  FAIL_THRESHOLD,
  HEALTH_PROBE_TIMEOUT_MS,
  NODE_HEALTH_PATH,
  STATUS_PATH,
  THROTTLE_FAIL_THRESHOLD,
  THROTTLE_PROBE_INTERVAL_MS,
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

export interface ProbeOutcome {
  node: NodeRecord;
  ok: boolean;
  latency_ms: number | null;
  error: string | null;
  applied_version: number | null;
  // 失败降频：本周期被跳过，未真实探测
  throttled?: boolean;
  backend_latencies?: Record<string, number | null>;
}

/**
 * 立即探测节点，失败后等 1s 重试，最多 maxRetries 次。
 * 首次成功即返回（不再重试），用于添加节点后的实时检测。
 */
export async function immediateProbe(
  node: NodeRecord,
  syncToken: string,
  maxRetries: number,
): Promise<NodeHealth> {
  let prev = emptyNodeHealth();
  for (let i = 0; i < maxRetries; i++) {
    const outcome = await probeNode(node, syncToken, prev);
    const merged = mergeHealth(prev, outcome);
    if (merged.healthy) return merged;
    prev = merged;
    if (i < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return prev;
}

export async function runHealthCycle(
  env: Env,
  ctx: ExecutionContext,
  force = false,
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
    nodesKV.nodes.map((n) =>
      probeNode(n, env.EMBY_SYNC_TOKEN, prevHealth.nodes[n.id] ?? emptyNodeHealth(), force),
    ),
  );

  const newHealth: HealthKV = {
    updated_at: new Date().toISOString(),
    nodes: {},
  };
  for (const o of outcomes) {
    const prev = prevHealth.nodes[o.node.id] ?? emptyNodeHealth();
    newHealth.nodes[o.node.id] = mergeHealth(prev, o);
  }
  await writeHealth(env, newHealth, prevHealth);

  // 补齐：节点 applied_version 与 KV embys.version 不一致（或未知）时异步补推
  ctx.waitUntil(
    backfillOutdatedNodes(env, embysKV, outcomes, newHealth),
  );
}

async function probeNode(
  node: NodeRecord,
  syncToken: string,
  prev: NodeHealth,
  force = false,
): Promise<ProbeOutcome> {
  // 失败降频：连续失败次数足够多时，只在窗口外才真正探测
  // force=true 时（手动探测）跳过节流，始终真实探测
  if (
    !force &&
    prev.consecutive_fails >= THROTTLE_FAIL_THRESHOLD &&
    prev.last_check !== null &&
    Date.now() - new Date(prev.last_check).getTime() < THROTTLE_PROBE_INTERVAL_MS
  ) {
    return {
      node,
      ok: false,
      latency_ms: null,
      error: null,
      applied_version: null,
      throttled: true,
    };
  }

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

    // 新版本节点：/__health 直接返回 {ok, applied_version, backend_latencies}
    // 老版本节点：返回文本 "ok"，需 fallback 到 /admin/status
    let appliedVersion: number | null = null;
    let backendLatencies: Record<string, number | null> | undefined;
    let parsedJson = false;
    try {
      const contentType = resp.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const data = (await resp.json()) as {
          applied_version?: unknown;
          backend_latencies?: Record<string, number | null>;
        };
        if (typeof data.applied_version === "number") {
          appliedVersion = data.applied_version;
        }
        if (data.backend_latencies && typeof data.backend_latencies === "object") {
          backendLatencies = data.backend_latencies;
        }
        parsedJson = true;
      }
    } catch {
      // 解析失败按非 JSON 处理
    }
    if (!parsedJson) {
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
    }

    return {
      node,
      ok: true,
      latency_ms: Date.now() - start,
      error: null,
      applied_version: appliedVersion,
      backend_latencies: backendLatencies,
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
 * - throttled 周期：prev 原样返回，不更新 last_check
 */
function mergeHealth(prev: NodeHealth, outcome: ProbeOutcome): NodeHealth {
  if (outcome.throttled) return prev;
  const now = new Date().toISOString();
  if (outcome.ok) {
    return {
      healthy: true,
      last_check: now,
      consecutive_fails: 0,
      last_latency_ms: outcome.latency_ms,
      applied_version: outcome.applied_version ?? prev.applied_version,
      last_sync_error: prev.last_sync_error,
      backend_latencies: outcome.backend_latencies ?? prev.backend_latencies,
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
    backend_latencies: prev.backend_latencies,
  };
}

async function backfillOutdatedNodes(
  env: Env,
  embysKV: EmbysKV,
  outcomes: ProbeOutcome[],
  health: HealthKV,
): Promise<void> {
  const targetVersion = embysKV.version;
  if (targetVersion === 0) return;

  const stale = outcomes.filter(
    // 节点健康但 version 未知（status 拉取失败）或确实过期，均触发补推
    (o) => o.ok && (o.applied_version === null || o.applied_version !== targetVersion),
  );
  if (stale.length === 0) return;

  const snapshot = buildSnapshot(embysKV);
  console.log(
    `[sync] backfill triggered targets=${stale.length} target_version=${targetVersion}`,
  );
  const results = await Promise.all(
    stale.map((o) =>
      pushSnapshotToNode(o.node, snapshot, env.EMBY_SYNC_TOKEN, "cron-backfill"),
    ),
  );
  // 把推送结果写回 health.last_sync_error
  await mergeSyncResults(env, health, results);
}

export async function mergeSyncResults(
  env: Env,
  _baseHealth: HealthKV,
  results: PushResult[],
): Promise<void> {
  if (results.length === 0) return;
  const latest = await readHealth(env);
  const next: HealthKV = {
    updated_at: new Date().toISOString(),
    nodes: { ...latest.nodes },
  };
  for (const r of results) {
    const prev = next.nodes[r.node_id] ?? emptyNodeHealth();
    next.nodes[r.node_id] = {
      ...prev,
      last_sync_error: r.status === "ok" ? null : (r.error ?? "sync error"),
      ...(r.status === "ok" && r.applied_version != null
        ? { applied_version: r.applied_version }
        : {}),
    };
  }
  await writeHealth(env, next, latest);
}
