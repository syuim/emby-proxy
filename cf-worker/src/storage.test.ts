import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ROUTING_TTL_MS, __resetRoutingCacheForTests, readRoutingSnapshot } from "./storage";
import type { Env } from "./types";

const T0 = 1_700_000_000_000;

// 假 D1：batch 按预设响应返回（对应 4 条语句），统计 batch 调用次数
function makeEnv(respond: () => unknown[]) {
  let batchCalls = 0;
  const db = {
    prepare(sql: string) {
      const stmt = { sql, bind: () => stmt };
      return stmt;
    },
    async batch(_stmts: unknown[]) {
      batchCalls++;
      return respond();
    },
  } as unknown as D1Database;
  return { env: { EMBY_DB: db } as Env, batchCalls: () => batchCalls };
}

function makeFailingEnv(mode: "reject" | "empty"): Env {
  return {
    EMBY_DB: {
      prepare: () => ({ bind() { return this; } }),
      batch: async () => {
        if (mode === "reject") throw new Error("D1 down");
        return [{ success: false, results: null }];
      },
    } as unknown as D1Database,
  } as Env;
}

const okResponse = () => [
  {
    success: true,
    results: [{ name: "dm", backend_url: "http://b.example", group_id: 2, created_at: "t0" }],
  },
  { success: true, results: [{ version: 7, proxy_mode: "node" }] },
  {
    success: true,
    results: [
      { id: "n1", name: "jp", public_url: "http://n1", created_at: "t0", isp_tags: '["cu"]', weight: 3, disabled: 0 },
    ],
  },
  {
    success: true,
    results: [
      { group_id: 2, node_id: "n1", is_backup: 0 },
      { group_id: 2, node_id: "n2", is_backup: 1 },
    ],
  },
];

beforeEach(() => {
  __resetRoutingCacheForTests();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("readRoutingSnapshot", () => {
  it("解析 embys/nodes/config/组关系，单次 batch", async () => {
    const { env, batchCalls } = makeEnv(okResponse);
    const snap = await readRoutingSnapshot(env);
    expect(batchCalls()).toBe(1);
    expect(snap.embys[0]!.name).toBe("dm");
    expect(snap.version).toBe(7);
    expect(snap.proxyMode).toBe("node");
    expect(snap.nodes[0]!.isp_tags).toEqual(["cu"]);
    expect(snap.nodes[0]!.weight).toBe(3);
    expect(snap.memberships[2]).toEqual({ primary: ["n1"], backup: ["n2"] });
  });

  it("TTL 内命中缓存不再读 D1；到期后重新读取", async () => {
    const { env, batchCalls } = makeEnv(okResponse);
    await readRoutingSnapshot(env);
    vi.setSystemTime(T0 + ROUTING_TTL_MS - 1);
    await readRoutingSnapshot(env);
    expect(batchCalls()).toBe(1);
    vi.setSystemTime(T0 + ROUTING_TTL_MS);
    await readRoutingSnapshot(env);
    expect(batchCalls()).toBe(2);
  });

  it("并发请求共享同一 in-flight 读取（只发一次 batch）", async () => {
    const { env, batchCalls } = makeEnv(okResponse);
    const [a, b] = await Promise.all([readRoutingSnapshot(env), readRoutingSnapshot(env)]);
    expect(batchCalls()).toBe(1);
    expect(a).toBe(b);
  });

  it("D1 失败时沿用上次成功快照（serve-stale，不返回空配置）", async () => {
    const { env } = makeEnv(okResponse);
    await readRoutingSnapshot(env);
    vi.setSystemTime(T0 + ROUTING_TTL_MS);
    const snap = await readRoutingSnapshot(makeFailingEnv("empty"));
    expect(snap.embys[0]?.name).toBe("dm");
  });

  it("无缓存且 D1 失败 → 返回空快照（维持旧行为，不抛异常）", async () => {
    const snap = await readRoutingSnapshot(makeFailingEnv("reject"));
    expect(snap.embys).toEqual([]);
    expect(snap.nodes).toEqual([]);
    expect(snap.memberships).toEqual({});
  });
});
