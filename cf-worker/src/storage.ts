import {
  KV_KEY_NODES,
  KV_KEY_EMBYS,
  KV_KEY_HEALTH,
} from "./constants";
import type {
  Env,
  NodesKV,
  EmbysKV,
  HealthKV,
  NodeHealth,
} from "./types";

const EMPTY_NODES: NodesKV = { nodes: [] };
const EMPTY_EMBYS: EmbysKV = { version: 0, embys: [] };
const EMPTY_HEALTH: HealthKV = { updated_at: "", nodes: {} };

export async function readNodes(env: Env): Promise<NodesKV> {
  const v = await env.EMBY_KV.get<NodesKV>(KV_KEY_NODES, "json");
  return v ?? structuredClone(EMPTY_NODES);
}

export async function readEmbys(env: Env): Promise<EmbysKV> {
  const v = await env.EMBY_KV.get<EmbysKV>(KV_KEY_EMBYS, "json");
  return v ?? structuredClone(EMPTY_EMBYS);
}

export async function readHealth(env: Env): Promise<HealthKV> {
  const v = await env.EMBY_KV.get<HealthKV>(KV_KEY_HEALTH, "json");
  return v ?? structuredClone(EMPTY_HEALTH);
}

export async function writeNodes(env: Env, value: NodesKV, cachedPrev?: NodesKV): Promise<void> {
  const prev = cachedPrev ?? await readNodes(env);
  if (nodesEqual(prev, value)) return;
  await env.EMBY_KV.put(KV_KEY_NODES, JSON.stringify(value));
}

export async function writeEmbys(env: Env, value: EmbysKV, cachedPrev?: EmbysKV): Promise<void> {
  const prev = cachedPrev ?? await readEmbys(env);
  if (embysEqual(prev, value)) return;
  await env.EMBY_KV.put(KV_KEY_EMBYS, JSON.stringify(value));
}

export async function writeHealth(env: Env, value: HealthKV, cachedPrev?: HealthKV): Promise<void> {
  const prev = cachedPrev ?? await readHealth(env);
  if (healthEqual(prev, value)) return;
  await env.EMBY_KV.put(KV_KEY_HEALTH, JSON.stringify(value));
}

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

// ---------- 比较函数 ----------
// 注意：last_check 与 updated_at 不参与比较，它们每次调用都会刷新，
// 纳入比较会让"比较后写"永远判"有变化"，失去省写入的意义。

export function nodesEqual(a: NodesKV, b: NodesKV): boolean {
  if (a.nodes.length !== b.nodes.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    const an = a.nodes[i];
    const bn = b.nodes[i];
    if (
      an.id !== bn.id ||
      an.name !== bn.name ||
      an.public_url !== bn.public_url ||
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
