import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { __resetAliveCacheForTests } from "./alive";
import { chooseNodeFromGroup, matchIspPool } from "./group";
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

function stubEnv(groupId: number, primary: string[], backup: string[] = []): Env {
  const db = {
    prepare: () => ({
      bind: () => ({
        all: async () => ({
          success: true,
          results: [
            ...primary.map((nodeId) => ({ node_id: nodeId, is_backup: 0 })),
            ...backup.map((nodeId) => ({ node_id: nodeId, is_backup: 1 })),
          ],
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

describe("matchIspPool", () => {
  const nCt = makeNode("n-ct", ["ct"]);
  const nCu = makeNode("n-cu", ["cu"]);
  const nCm = makeNode("n-cm", ["cm"]);
  const nAny = makeNode("n-any", []);
  const nAll = makeNode("n-all", ["ct", "cu", "cm"]);
  const alive = [nCt, nCu, nCm, nAny, nAll];

  it("isp=ct 只保留 ct 标签与未标注 node", () => {
    expect(matchIspPool(alive, "ct").map((n) => n.id)).toEqual(["n-ct", "n-any", "n-all"]);
  });

  it("isp=overseas 只保留 overseas 标签与未标注 node", () => {
    const nOs = makeNode("n-os", ["overseas"]);
    expect(matchIspPool([...alive, nOs], "overseas").map((n) => n.id)).toEqual([
      "n-any",
      "n-os",
    ]);
  });

  it("无匹配 → 空数组（不回退；回退由路由上层决策）", () => {
    expect(matchIspPool([nCu, nCm], "ct")).toEqual([]);
  });

  it("匹配集非空时不回退（cu 组 + ct 入口保留 cu 池）", () => {
    expect(matchIspPool([nCt, nCu], "cu").map((n) => n.id)).toEqual(["n-cu"]);
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

  it("主节点存活但均无网络匹配（无备用）→ 错配兜底 stage=fallback", async () => {
    const env = stubEnv(1, ["n-ct", "n-cu"]);
    // 只有 cu 存活，ct 节点已挂；入口 ct 时主池存活节点均不匹配
    mockNodeHealth(new Set(["n-cu"]));
    const nodes = [makeNode("n-ct", ["ct"]), makeNode("n-cu", ["cu"])];
    const pick = await chooseNodeFromGroup(env, 1, nodes, "ct");
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-cu");
    expect(pick!.stage).toBe("fallback");
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

  // ---------- 备用节点 ----------

  it("主成员全灭 + 备用存活 → 启用备用池（stage=backup）", async () => {
    const env = stubEnv(1, ["n-main"], ["n-back"]);
    mockNodeHealth(new Set(["n-back"]));
    const nodes = [makeNode("n-main", ["ct"]), makeNode("n-back", ["ct"])];
    const pick = await chooseNodeFromGroup(env, 1, nodes, "ct");
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-back");
    expect(pick!.stage).toBe("backup");
  });

  it("主成员存活时备用节点不参与选择（stage=primary）", async () => {
    const env = stubEnv(1, ["n-main", "n-main2"], ["n-back"]);
    mockNodeHealth(new Set(["n-main", "n-main2", "n-back"]));
    const nodes = [
      makeNode("n-main", ["ct"]),
      makeNode("n-main2", ["ct"]),
      makeNode("n-back", ["ct"]),
    ];
    for (let i = 0; i < 20; i++) {
      const pick = await chooseNodeFromGroup(env, 1, nodes, "ct");
      expect(pick).not.toBeNull();
      expect(["n-main", "n-main2"]).toContain(pick!.node.id);
      expect(pick!.stage).toBe("primary");
    }
  });

  it("主成员全灭 + 备用也全灭 → null", async () => {
    const env = stubEnv(1, ["n-main"], ["n-back"]);
    mockNodeHealth(new Set());
    const nodes = [makeNode("n-main", ["ct"]), makeNode("n-back", ["ct"])];
    expect(await chooseNodeFromGroup(env, 1, nodes, "ct")).toBeNull();
  });

  it("组无主成员仅配置备用节点 → 备用直接当主用", async () => {
    const env = stubEnv(1, [], ["n-back"]);
    mockNodeHealth(new Set(["n-back"]));
    const nodes = [makeNode("n-back", ["ct"])];
    const pick = await chooseNodeFromGroup(env, 1, nodes, "ct");
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-back");
    expect(pick!.stage).toBe("backup");
  });

  it("overseas 入口：主存活但无匹配 + 备用含 overseas → 选备用（stage=backup）", async () => {
    const env = stubEnv(1, ["n-main"], ["n-back"]);
    mockNodeHealth(new Set(["n-main", "n-back"]));
    const nodes = [
      makeNode("n-main", ["ct"]),
      makeNode("n-back", ["overseas"]),
    ];
    const pick = await chooseNodeFromGroup(env, 1, nodes, "overseas");
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-back");
    expect(pick!.stage).toBe("backup");
  });

  it("overseas 入口：主全灭 + 备用含 overseas 标签 → 选备用", async () => {
    const env = stubEnv(1, ["n-main"], ["n-os", "n-cu"]);
    mockNodeHealth(new Set(["n-os", "n-cu"]));
    const nodes = [
      makeNode("n-main", ["ct"]),
      makeNode("n-os", ["overseas"]),
      makeNode("n-cu", ["cu"]),
    ];
    const pick = await chooseNodeFromGroup(env, 1, nodes, "overseas");
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-os");
    expect(pick!.stage).toBe("backup");
  });

  it("主成员全部禁用 + 备用存活 → 选备用", async () => {
    const env = stubEnv(1, ["n-main"], ["n-back"]);
    mockNodeHealth(new Set(["n-main", "n-back"]));
    const nodes = [makeNode("n-main", ["ct"], true), makeNode("n-back", ["ct"])];
    const pick = await chooseNodeFromGroup(env, 1, nodes, "ct");
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-back");
    expect(pick!.stage).toBe("backup");
  });

  // ---------- AS 无匹配时启用备用 ----------

  it("主存活但无网络匹配 + 备用匹配 → 切备用（stage=backup）", async () => {
    const env = stubEnv(1, ["n-cu"], ["n-back"]);
    mockNodeHealth(new Set(["n-cu", "n-back"]));
    const nodes = [makeNode("n-cu", ["cu"]), makeNode("n-back", ["ct"])];
    const pick = await chooseNodeFromGroup(env, 1, nodes, "ct");
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-back");
    expect(pick!.stage).toBe("backup");
  });

  it("主存活但无匹配 + 备用也无匹配（国内入口）→ 全存活错配兜底", async () => {
    const env = stubEnv(1, ["n-cu"], ["n-cm"]);
    mockNodeHealth(new Set(["n-cu", "n-cm"]));
    const nodes = [makeNode("n-cu", ["cu"]), makeNode("n-cm", ["cm"])];
    for (let i = 0; i < 20; i++) {
      const pick = await chooseNodeFromGroup(env, 1, nodes, "ct");
      expect(pick).not.toBeNull();
      expect(["n-cu", "n-cm"]).toContain(pick!.node.id);
      expect(pick!.stage).toBe("fallback");
    }
  });

  it("主备用均存活但无匹配（overseas 入口）→ null（不跨网错配）", async () => {
    const env = stubEnv(1, ["n-cu"], ["n-cm"]);
    mockNodeHealth(new Set(["n-cu", "n-cm"]));
    const nodes = [makeNode("n-cu", ["cu"]), makeNode("n-cm", ["cm"])];
    expect(await chooseNodeFromGroup(env, 1, nodes, "overseas")).toBeNull();
  });
});
