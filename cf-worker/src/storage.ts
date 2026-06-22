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

const EMPTY_NODES: NodesKV = { version: 0, nodes: [] };
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

export async function writeNodes(env: Env, value: NodesKV): Promise<void> {
  await env.EMBY_KV.put(KV_KEY_NODES, JSON.stringify(value));
}

export async function writeEmbys(env: Env, value: EmbysKV): Promise<void> {
  await env.EMBY_KV.put(KV_KEY_EMBYS, JSON.stringify(value));
}

export async function writeHealth(env: Env, value: HealthKV): Promise<void> {
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
