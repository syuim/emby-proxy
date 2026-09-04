import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { __resetAliveCacheForTests } from "./alive";
import { chooseNodeFromGroup, filterGroupPool } from "./group";
import type { Env, NodeRecord } from "./types";

function makeNode(id: string, ispTags: string[] = [], disabled = false): NodeRecord {
  return {
    id,
    name: id,
    public_url: `https://${id}.example.com`,
    created_at: "2026-01-01T00:00:00Z",
    isp_tags: ispTags,
    disabled,
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

  it("isp=overseas 只保留 overseas 标签与未标注 node", () => {
    const nOs = makeNode("n-os", ["overseas"]);
    const { pool, matched } = filterGroupPool([...alive, nOs], "overseas");
    expect(pool.map((n) => n.id)).toEqual(["n-any", "n-os"]);
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
    }
  });

  it("匹配 ISP 的 node 全不健康 → 回退组内其它存活 node", async () => {
    const env = stubEnv(1, ["n-ct", "n-cu"]);
    // 只有 cu 存活，ct 节点已挂
    mockNodeHealth(new Set(["n-cu"]));
    const nodes = [makeNode("n-ct", ["ct"]), makeNode("n-cu", ["cu"])];
    const pick = await chooseNodeFromGroup(env, 1, nodes, "ct");
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-cu");
  });

  it("组内 node 全灭 → null", async () => {
    const env = stubEnv(1, ["n-ct", "n-cu"]);
    mockNodeHealth(new Set());
    const nodes = [makeNode("n-ct", ["ct"]), makeNode("n-cu", ["cu"])];
    expect(await chooseNodeFromGroup(env, 1, nodes, "ct")).toBeNull();
  });

  it("禁用的 node 视为不可达：即使服务健康也不选中", async () => {
    const env = stubEnv(1, ["n-disabled", "n-ok"]);
    mockNodeHealth(new Set(["n-disabled", "n-ok"])); // 探测角度看两者都在线
    const nodes = [makeNode("n-disabled", [], true), makeNode("n-ok", [])];
    for (let i = 0; i < 20; i++) {
      const pick = await chooseNodeFromGroup(env, 1, nodes, "ct");
      expect(pick).not.toBeNull();
      expect(pick!.node.id).toBe("n-ok");
    }
  });

  it("组内 node 全部被禁用 → null（Worker local 兜底）", async () => {
    const env = stubEnv(1, ["n-disabled"]);
    mockNodeHealth(new Set(["n-disabled"]));
    const nodes = [makeNode("n-disabled", [], true)];
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

  it("overseas 入口：组内无 overseas 标签节点 → null", async () => {
    const env = stubEnv(1, ["n-ct", "n-cu"]);
    mockNodeHealth(new Set(["n-ct", "n-cu"]));
    const nodes = [makeNode("n-ct", ["ct"]), makeNode("n-cu", ["cu"])];
    const pick = await chooseNodeFromGroup(env, 1, nodes, "overseas");
    expect(pick).toBeNull();
  });

  it("overseas 入口：组内有 overseas 标签节点 → 从中选", async () => {
    const env = stubEnv(1, ["n-overseas", "n-cu"]);
    mockNodeHealth(new Set(["n-overseas", "n-cu"]));
    const nodes = [makeNode("n-overseas", ["overseas"]), makeNode("n-cu", ["cu"])];
    const pick = await chooseNodeFromGroup(env, 1, nodes, "overseas");
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-overseas");
  });
});
