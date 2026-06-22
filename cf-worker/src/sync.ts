import { SYNC_PATH, SYNC_PUSH_TIMEOUT_MS } from "./constants";
import type {
  EmbysKV,
  NodeRecord,
  PushResult,
  SyncSnapshot,
} from "./types";

/**
 * 把 KV 内部的 emby 列表映射成节点 /admin/sync 期望的旧 schema：
 * {version, proxies:[{path_prefix, backend_url}]}.
 * Worker 内部用 emby_name，仅出站时映射为 path_prefix（决策 #2）。
 */
export function buildSnapshot(embysKV: EmbysKV): SyncSnapshot {
  return {
    version: embysKV.version,
    proxies: embysKV.embys.map((e) => ({
      path_prefix: e.name,
      backend_url: e.backend_url,
    })),
  };
}

export async function pushSnapshotToNode(
  node: NodeRecord,
  snapshot: SyncSnapshot,
  syncToken: string,
): Promise<PushResult> {
  const url = node.public_url.replace(/\/$/, "") + SYNC_PATH;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_PUSH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${syncToken}`,
      },
      body: JSON.stringify(snapshot),
      signal: controller.signal,
    });
    if (resp.ok) {
      return { node_id: node.id, status: "ok", http_status: resp.status, error: null };
    }
    const body = (await resp.text()).slice(0, 200);
    return {
      node_id: node.id,
      status: "error",
      http_status: resp.status,
      error: `HTTP ${resp.status}: ${body}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { node_id: node.id, status: "error", error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export async function pushSnapshotToAll(
  nodes: NodeRecord[],
  snapshot: SyncSnapshot,
  syncToken: string,
): Promise<PushResult[]> {
  const settled = await Promise.allSettled(
    nodes.map((n) => pushSnapshotToNode(n, snapshot, syncToken)),
  );
  return settled.map((r, i): PushResult => {
    if (r.status === "fulfilled") return r.value;
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return { node_id: nodes[i]!.id, status: "error", error: msg };
  });
}
