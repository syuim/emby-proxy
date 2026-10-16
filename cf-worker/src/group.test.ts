import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { __resetAliveCacheForTests } from "./alive";
import { chooseNodeFromGroup, matchIspPool, pickWeighted } from "./group";
import type { GroupMemberships } from "./storage";
import type { NodeRecord } from "./types";

function makeNode(id: string, ispTags: string[] = [], disabled = false, weight = 1): NodeRecord {
  return {
    id,
    name: id,
    public_url: `https://${id}.example.com`,
    created_at: "2026-01-01T00:00:00Z",
    isp_tags: ispTags,
    weight,
    disabled,
  };
}

/** 构造 node_groups 成员表（group_id → 主/备节点 id 列表），未列出的组视为不存在 */
function memberships(
  spec: Record<number, { primary?: string[]; backup?: string[] }>,
): GroupMemberships {
  const out: GroupMemberships = {};
  for (const [gid, m] of Object.entries(spec)) {
    out[Number(gid)] = { primary: m.primary ?? [], backup: m.backup ?? [] };
  }
  return out;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
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

  it("isp=overseas 只保留未标注 node（节点已无 overseas 标签）", () => {
    expect(matchIspPool(alive, "overseas").map((n) => n.id)).toEqual(["n-any"]);
  });

  it("无匹配 → 空数组（不回退；回退由路由上层决策）", () => {
    expect(matchIspPool([nCu, nCm], "ct")).toEqual([]);
  });

  it("匹配集非空时不回退（cu 组 + ct 入口保留 cu 池）", () => {
    expect(matchIspPool([nCt, nCu], "cu").map((n) => n.id)).toEqual(["n-cu"]);
  });
});

describe("pickWeighted", () => {
  it("按权重划分区间（固定 Math.random 验证落点）", () => {
    const a = makeNode("a", [], false, 1);
    const b = makeNode("b", [], false, 9);
    const spy = vi.spyOn(Math, "random");
    spy.mockReturnValue(0.05); // r = 0.5 → 落在 a 的 [0,1)
    expect(pickWeighted([a, b]).id).toBe("a");
    spy.mockReturnValue(0.5); // r = 5 → 落在 b 的 [1,10)
    expect(pickWeighted([a, b]).id).toBe("b");
    spy.mockReturnValue(0.999); // 上边界附近仍落在 b
    expect(pickWeighted([a, b]).id).toBe("b");
  });

  it("单节点池恒定返回该节点", () => {
    const a = makeNode("a");
    for (let i = 0; i < 10; i++) {
      expect(pickWeighted([a]).id).toBe("a");
    }
  });

  it("非法权重（NaN/0）兜底按 1 计", () => {
    const a = makeNode("a");
    a.weight = NaN;
    const b = makeNode("b");
    b.weight = 0;
    const spy = vi.spyOn(Math, "random");
    spy.mockReturnValue(0.25); // 等权 total=2：r=0.5 → a
    expect(pickWeighted([a, b]).id).toBe("a");
    spy.mockReturnValue(0.75); // r=1.5 → b
    expect(pickWeighted([a, b]).id).toBe("b");
  });

  it("统计：1:9 权重抽样万次占比收敛在 0.9 附近", () => {
    const a = makeNode("a", [], false, 1);
    const b = makeNode("b", [], false, 9);
    let hitB = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) {
      if (pickWeighted([a, b]).id === "b") hitB++;
    }
    const ratio = hitB / n;
    expect(ratio).toBeGreaterThan(0.86);
    expect(ratio).toBeLessThan(0.94);
  });
});

describe("chooseNodeFromGroup", () => {
  it("isp=ct 时只从 ct/未标注存活 node 中选", async () => {
    mockNodeHealth(new Set(["n-ct", "n-cu", "n-any"]));
    const nodes = [makeNode("n-ct", ["ct"]), makeNode("n-cu", ["cu"]), makeNode("n-any", [])];
    const m = memberships({ 1: { primary: ["n-ct", "n-cu", "n-any"] } });
    for (let i = 0; i < 30; i++) {
      const pick = await chooseNodeFromGroup(1, nodes, m, "ct");
      expect(pick).not.toBeNull();
      expect(["n-ct", "n-any"]).toContain(pick!.node.id);
    }
  });

  it("主节点存活但均无网络匹配（无备用）→ 错配兜底 stage=fallback", async () => {
    // 只有 cu 存活，ct 节点已挂；入口 ct 时主池存活节点均不匹配
    mockNodeHealth(new Set(["n-cu"]));
    const nodes = [makeNode("n-ct", ["ct"]), makeNode("n-cu", ["cu"])];
    const pick = await chooseNodeFromGroup(
      1,
      nodes,
      memberships({ 1: { primary: ["n-ct", "n-cu"] } }),
      "ct",
    );
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-cu");
    expect(pick!.stage).toBe("fallback");
  });

  it("组内 node 全灭 → null", async () => {
    mockNodeHealth(new Set());
    const nodes = [makeNode("n-ct", ["ct"]), makeNode("n-cu", ["cu"])];
    expect(
      await chooseNodeFromGroup(1, nodes, memberships({ 1: { primary: ["n-ct", "n-cu"] } }), "ct"),
    ).toBeNull();
  });

  it("禁用的 node 视为不可达：即使服务健康也不选中", async () => {
    mockNodeHealth(new Set(["n-disabled", "n-ok"])); // 探测角度看两者都在线
    const nodes = [makeNode("n-disabled", [], true), makeNode("n-ok", [])];
    const m = memberships({ 1: { primary: ["n-disabled", "n-ok"] } });
    for (let i = 0; i < 20; i++) {
      const pick = await chooseNodeFromGroup(1, nodes, m, "ct");
      expect(pick).not.toBeNull();
      expect(pick!.node.id).toBe("n-ok");
    }
  });

  it("组内 node 全部被禁用 → null（Worker local 兜底）", async () => {
    mockNodeHealth(new Set(["n-disabled"]));
    const nodes = [makeNode("n-disabled", [], true)];
    expect(
      await chooseNodeFromGroup(1, nodes, memberships({ 1: { primary: ["n-disabled"] } }), "ct"),
    ).toBeNull();
  });

  it("组不存在（无成员记录）→ null", async () => {
    mockNodeHealth(new Set(["n-ct"]));
    const nodes = [makeNode("n-ct", ["ct"])];
    expect(await chooseNodeFromGroup(99, nodes, memberships({}), "ct")).toBeNull();
  });

  it("组内成员 node 不在 nodes 列表（已删）→ null", async () => {
    mockNodeHealth(new Set(["n-ghost"]));
    const nodes = [makeNode("n-ct", ["ct"])];
    expect(
      await chooseNodeFromGroup(1, nodes, memberships({ 1: { primary: ["n-ghost"] } }), "ct"),
    ).toBeNull();
  });

  it("overseas 入口 → null：即使未标注 node 存活也不选（router 先行 307 直连后端）", async () => {
    mockNodeHealth(new Set(["n-any"]));
    const nodes = [makeNode("n-any", [])];
    expect(
      await chooseNodeFromGroup(1, nodes, memberships({ 1: { primary: ["n-any"] } }), "overseas"),
    ).toBeNull();
  });

  // ---------- 备用节点 ----------

  it("主成员全灭 + 备用存活 → 启用备用池（stage=backup）", async () => {
    mockNodeHealth(new Set(["n-back"]));
    const nodes = [makeNode("n-main", ["ct"]), makeNode("n-back", ["ct"])];
    const pick = await chooseNodeFromGroup(
      1,
      nodes,
      memberships({ 1: { primary: ["n-main"], backup: ["n-back"] } }),
      "ct",
    );
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-back");
    expect(pick!.stage).toBe("backup");
  });

  it("主成员存活时备用节点不参与选择（stage=primary）", async () => {
    mockNodeHealth(new Set(["n-main", "n-main2", "n-back"]));
    const nodes = [
      makeNode("n-main", ["ct"]),
      makeNode("n-main2", ["ct"]),
      makeNode("n-back", ["ct"]),
    ];
    const m = memberships({ 1: { primary: ["n-main", "n-main2"], backup: ["n-back"] } });
    for (let i = 0; i < 20; i++) {
      const pick = await chooseNodeFromGroup(1, nodes, m, "ct");
      expect(pick).not.toBeNull();
      expect(["n-main", "n-main2"]).toContain(pick!.node.id);
      expect(pick!.stage).toBe("primary");
    }
  });

  it("主成员全灭 + 备用也全灭 → null", async () => {
    mockNodeHealth(new Set());
    const nodes = [makeNode("n-main", ["ct"]), makeNode("n-back", ["ct"])];
    expect(
      await chooseNodeFromGroup(
        1,
        nodes,
        memberships({ 1: { primary: ["n-main"], backup: ["n-back"] } }),
        "ct",
      ),
    ).toBeNull();
  });

  it("组无主成员仅配置备用节点 → 备用直接当主用", async () => {
    mockNodeHealth(new Set(["n-back"]));
    const nodes = [makeNode("n-back", ["ct"])];
    const pick = await chooseNodeFromGroup(
      1,
      nodes,
      memberships({ 1: { backup: ["n-back"] } }),
      "ct",
    );
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-back");
    expect(pick!.stage).toBe("backup");
  });

  it("overseas 入口 → null：主备均存活也不启用备用池", async () => {
    mockNodeHealth(new Set(["n-main", "n-back"]));
    const nodes = [makeNode("n-main", ["ct"]), makeNode("n-back", [])];
    expect(
      await chooseNodeFromGroup(
        1,
        nodes,
        memberships({ 1: { primary: ["n-main"], backup: ["n-back"] } }),
        "overseas",
      ),
    ).toBeNull();
  });

  it("主成员全部禁用 + 备用存活 → 选备用", async () => {
    mockNodeHealth(new Set(["n-main", "n-back"]));
    const nodes = [makeNode("n-main", ["ct"], true), makeNode("n-back", ["ct"])];
    const pick = await chooseNodeFromGroup(
      1,
      nodes,
      memberships({ 1: { primary: ["n-main"], backup: ["n-back"] } }),
      "ct",
    );
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-back");
    expect(pick!.stage).toBe("backup");
  });

  // ---------- AS 无匹配时启用备用 ----------

  it("主存活但无网络匹配 + 备用匹配 → 切备用（stage=backup）", async () => {
    mockNodeHealth(new Set(["n-cu", "n-back"]));
    const nodes = [makeNode("n-cu", ["cu"]), makeNode("n-back", ["ct"])];
    const pick = await chooseNodeFromGroup(
      1,
      nodes,
      memberships({ 1: { primary: ["n-cu"], backup: ["n-back"] } }),
      "ct",
    );
    expect(pick).not.toBeNull();
    expect(pick!.node.id).toBe("n-back");
    expect(pick!.stage).toBe("backup");
  });

  it("主存活但无匹配 + 备用也无匹配（国内入口）→ 全存活错配兜底", async () => {
    mockNodeHealth(new Set(["n-cu", "n-cm"]));
    const nodes = [makeNode("n-cu", ["cu"]), makeNode("n-cm", ["cm"])];
    const m = memberships({ 1: { primary: ["n-cu"], backup: ["n-cm"] } });
    for (let i = 0; i < 20; i++) {
      const pick = await chooseNodeFromGroup(1, nodes, m, "ct");
      expect(pick).not.toBeNull();
      expect(["n-cu", "n-cm"]).toContain(pick!.node.id);
      expect(pick!.stage).toBe("fallback");
    }
  });

  // ---------- 节点权重 ----------

  it("池内按权重倾斜：低权节点被选中次数显著更少", async () => {
    mockNodeHealth(new Set(["n-low", "n-high"]));
    const nodes = [makeNode("n-low", [], false, 1), makeNode("n-high", [], false, 9)];
    const m = memberships({ 1: { primary: ["n-low", "n-high"] } });
    let low = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) {
      const pick = await chooseNodeFromGroup(1, nodes, m, "ct");
      expect(pick).not.toBeNull();
      expect(pick!.stage).toBe("primary");
      if (pick!.node.id === "n-low") low++;
    }
    expect(low / n).toBeLessThan(0.2);
  });

  it("权重不改变池优先级：主池可用时不选权重更高的备用节点", async () => {
    mockNodeHealth(new Set(["n-main", "n-back"]));
    const nodes = [makeNode("n-main", ["ct"], false, 1), makeNode("n-back", ["ct"], false, 100)];
    const m = memberships({ 1: { primary: ["n-main"], backup: ["n-back"] } });
    for (let i = 0; i < 20; i++) {
      const pick = await chooseNodeFromGroup(1, nodes, m, "ct");
      expect(pick!.node.id).toBe("n-main");
      expect(pick!.stage).toBe("primary");
    }
  });
});
