import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { __resetAliveCacheForTests, probeAlive } from "./alive";
import type { NodeRecord } from "./types";

function makeNode(id: string, url = `https://${id}.example.com`, disabled = false): NodeRecord {
  return { id, name: id, public_url: url, created_at: "t0", isp_tags: [], weight: 1, disabled };
}

const origFetch = globalThis.fetch;
beforeEach(() => {
  __resetAliveCacheForTests();
});
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

describe("probeAlive", () => {
  it("并发探测同一节点只发一次请求（in-flight 去重）", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response("ok", { status: 200 });
    }) as any;
    const node = makeNode("n1");
    const results = await Promise.all([probeAlive(node), probeAlive(node), probeAlive(node)]);
    expect(calls).toBe(1);
    expect(results).toEqual([true, true, true]);
  });

  it("TTL 内命中缓存不再探测；URL 变更后旧结果不再命中", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as any;
    const node = makeNode("n1");
    await probeAlive(node);
    await probeAlive(node);
    expect(calls).toBe(1);
    const moved = makeNode("n1", "https://new.example.com");
    await probeAlive(moved);
    expect(calls).toBe(2);
  });

  it("禁用节点直接返回 false，不发起探测", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as any;
    expect(await probeAlive(makeNode("n1", "https://n1.example.com", true))).toBe(false);
    expect(calls).toBe(0);
  });
});
