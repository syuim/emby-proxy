import { HEALTH_PROBE_TIMEOUT_MS, NODE_HEALTH_PATH } from "./constants";
import type { NodeRecord } from "./types";

// 请求级存活探测：GET /__health，3s 超时，isolate 内存缓存。
// 非对称 TTL：活 30s（控制节点刚挂时的盲区），死 15s（更快重试发现恢复）。
// 节点失败的判定以此为准（请求驱动、秒级发现），不依赖 cron 探活周期。
const aliveCache = new Map<string, { alive: boolean; ts: number }>();
const ALIVE_TTL_OK_MS = 30_000;
const ALIVE_TTL_FAIL_MS = 15_000;

export async function probeAlive(node: NodeRecord): Promise<boolean> {
  // 禁用 = 不可达：不探测也不写缓存，恢复启用即刻生效（无 TTL 残留）
  if (node.disabled) return false;

  const hit = aliveCache.get(node.id);
  if (hit && Date.now() - hit.ts < (hit.alive ? ALIVE_TTL_OK_MS : ALIVE_TTL_FAIL_MS)) {
    return hit.alive;
  }

  let alive = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(
      node.public_url.replace(/\/$/, "") + NODE_HEALTH_PATH,
      { signal: controller.signal },
    );
    alive = resp.ok;
  } catch {
    alive = false;
  } finally {
    clearTimeout(timer);
  }
  aliveCache.set(node.id, { alive, ts: Date.now() });
  return alive;
}

// 仅供测试：vitest 用例间清空探测缓存，避免跨用例的 TTL 残留
export function __resetAliveCacheForTests(): void {
  aliveCache.clear();
}
