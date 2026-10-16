import { HEALTH_PROBE_TIMEOUT_MS, NODE_HEALTH_PATH } from "./constants";
import type { NodeRecord } from "./types";

// 请求级存活探测：GET /__health，3s 超时，isolate 内存缓存。
// 非对称 TTL：活 30s（控制节点刚挂时的盲区），死 15s（更快重试发现恢复）。
// 节点失败的判定以此为准（请求驱动、秒级发现），不依赖 cron 探活周期。
const aliveCache = new Map<string, { alive: boolean; ts: number }>();
// 同 key 并发探测共享一个 in-flight Promise，避免缓存过期瞬间的探测风暴
const inflight = new Map<string, Promise<boolean>>();
const ALIVE_TTL_OK_MS = 30_000;
const ALIVE_TTL_FAIL_MS = 15_000;

// 缓存键含 public_url：节点换 URL 后旧结果不再命中（同 id 不同 URL 视为两个目标）
function cacheKey(node: NodeRecord): string {
  return node.id + "|" + node.public_url;
}

export async function probeAlive(node: NodeRecord): Promise<boolean> {
  // 禁用 = 不可达：不探测也不写缓存，恢复启用即刻生效（无 TTL 残留）
  if (node.disabled) return false;

  const key = cacheKey(node);
  const hit = aliveCache.get(key);
  if (hit && Date.now() - hit.ts < (hit.alive ? ALIVE_TTL_OK_MS : ALIVE_TTL_FAIL_MS)) {
    return hit.alive;
  }
  const existing = inflight.get(key);
  if (existing) return existing;

  const task = (async () => {
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
    aliveCache.set(key, { alive, ts: Date.now() });
    return alive;
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}

// 仅供测试：vitest 用例间清空探测缓存，避免跨用例的 TTL 残留
export function __resetAliveCacheForTests(): void {
  aliveCache.clear();
  inflight.clear();
}
