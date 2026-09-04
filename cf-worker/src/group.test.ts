import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { __resetAliveCacheForTests } from "./alive";
import { chooseNodeFromGroup, filterGroupPool } from "./group";
import type { Env, NodeRecord } from "./types";

function makeNode(id: string, ispTags: string[] = []): NodeRecord {
  return {
    id,
    name: id,
    public_url: `https://${id}.example.com`,
    created_at: "2026-01-01T00:00:00Z",
    sort_order: 0,
    isp_tags: ispTags,
  };
}

function stubEnv(groupId: number, memberIds: string[]): Env {
  const db = {
    prepare: () => ({
      bind: () => ({
        all: async () => ({
          success: true,
          results: memberIds.map((nodeId) => ({ node_id: nodeId })),
        }),
        run: async () => ({ success: true, meta: {} }),
        first: async () => null,
      }),
      all: async () => ({ success: true, results: [] }),
      run: async () => ({ success: true, meta: {} }),
      first: async () => null,
    }),
    batch: async () => [],
  };
  void groupId;
  return { EMBY_DB: db as unknown as Env["EMBY_DB"], ADMIN_TOKEN: "t", EMBY_SYNC_TOKEN: "t" };
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});
beforeEach(() => {
  __resetAliveCacheForTests();
});

function mockNodeHealth(aliveIds: Set<string>) {
  globalThis.fetch = vi.fn(async (input: any) => {
    const u = new URL(String(input));
    const id = u.hostname.split(".")[0];
    return new Response(aliveIds.has(id) ? "ok" : "down", {
      status: aliveIds.has(id) ? 200 : 503,
    });
  }) as any;
}

describe("filterGroupPool", () => {
  const nCt = makeNode("n-ct", ["ct"]);
  const nCu = makeNode("n-cu", ["cu"]);
  const nCm = makeNode("n-cm", ["cm"]);
  const nAny = makeNode("n-any", []);
  const nAll = makeNode("n-all", ["ct", "cu", "cm"]);
  const alive = [nCt, nCu, nCm, nAny, nAll];

  it("isp=ct 只保留 ct 标签与未标注 node", () => {
    const { pool, matched } = filterGroupPool(alive, "ct");
    expect(pool.map((n) => n.id)).toEqual(["n-ct", "n-any", "n-all"]);
    expect(matched).toBe(true);
  });

  it("isp=unknown 不过滤", () => {
    const { pool, matched } = filterGroupPool(alive, "unknown");
    expect(pool).toEqual(alive);
    expect(matched).toBe(true);
  });

  it("组内无匹配 ISP → 回退全部存活 node 并标记 matched=false", () => {
    const { pool, matched } = filterGroupPool([nCu, nCm], "ct");
    expect(pool.map((n) => n.id)).toEqual(["n-cu", "n-cm"]);
    expect(matched).toBe(false);
  });

  it("匹配集非空时不回退（cu 组 + ct 入口保留 cu 池）", () => {
    const { pool, matched } = filterGroupPool([nCt, nCu], "cu");
    expect(pool.map((n) => n.id)).toEqual(["n-cu"]);
    expect(matched).toBe(true);
  });
});

describe("chooseNodeFromGroup", () => {
  it("isp=ct 时只从 ct/未标注存活 node 中选", async () => {
    const env = stubEnv(1, ["n-ct", "n-cu", "n-any"]);
    mockNodeHealth(new Set(["n-ct", "n-cu", "n-any"]));
    const nodes = [makeNode("n-ct", ["ct"]), makeNode("n-cu", ["cu"]), makeNode("n-any", [])];
    for (let i = 0; i < 30; i++) {
      const pick = await chooseNodeFromGroup(env, 1, nodes, "ct");
      expect(pick).not.toBeNull();
      expect(["n-ct", "n-any"]).toContain(pick!.node.id);
      expect(pick!.ispMatched).toBe(true);
    }
  });

  it("匹配 ISP 的 node 全不健康 → 回退组内其它存活 node（ispMatched=false）", async () => {
    const env = stubEnv(1, ["n-ct", "n-cu"]);
    // 只有 cu 存活，ct 节点已挂
    mockNodeHealth(new Set(["n-cu"]));
    const nodes = [makeNode("n-ct", ["ct"]), makeNode("n-cu", ["cu"])];
    const pick = await chooseNodeFromGroup(env, 1, nodes, "ct");
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-cu");
    expect(pick!.ispMatched).toBe(false);
  });

  it("组内 node 全灭 → null", async () => {
    const env = stubEnv(1, ["n-ct", "n-cu"]);
    mockNodeHealth(new Set());
    const nodes = [makeNode("n-ct", ["ct"]), makeNode("n-cu", ["cu"])];
    expect(await chooseNodeFromGroup(env, 1, nodes, "ct")).toBeNull();
  });

  it("组不存在（无成员记录）→ null", async () => {
    const env = stubEnv(99, []);
    mockNodeHealth(new Set(["n-ct"]));
    const nodes = [makeNode("n-ct", ["ct"])];
    expect(await chooseNodeFromGroup(env, 99, nodes, "ct")).toBeNull();
  });

  it("组内成员 node 不在 nodes 列表（已删）→ null", async () => {
    const env = stubEnv(1, ["n-ghost"]);
    mockNodeHealth(new Set(["n-ghost"]));
    const nodes = [makeNode("n-ct", ["ct"])];
    expect(await chooseNodeFromGroup(env, 1, nodes, "ct")).toBeNull();
  });

  it("unknown 入口不按 ISP 过滤", async () => {
    const env = stubEnv(1, ["n-ct", "n-cu"]);
    mockNodeHealth(new Set(["n-ct", "n-cu"]));
    const nodes = [makeNode("n-ct", ["ct"]), makeNode("n-cu", ["cu"])];
    for (let i = 0; i < 20; i++) {
      const pick = await chooseNodeFromGroup(env, 1, nodes, "unknown");
      expect(["n-ct", "n-cu"]).toContain(pick!.node.id);
    }
  });
});
