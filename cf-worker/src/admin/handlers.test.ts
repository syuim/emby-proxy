import { describe, it, expect } from "vitest";
import {
  handleCreateGroup,
  handleDeleteNode,
  handleUpdateGroup,
  handleUpdateNode,
} from "./handlers";
import type { Env } from "../types";

type Stmt = { sql: string; args: unknown[] };
type FakeStmt = Stmt & {
  bind: (...args: unknown[]) => FakeStmt;
  all: () => Promise<unknown>;
};

type NodeRow = {
  id: string;
  name: string;
  public_url: string;
  created_at: string;
  isp_tags: string | null;
  weight: number;
  disabled: number;
};

function node(id: string, name: string, disabled = false): NodeRow {
  return {
    id,
    name,
    public_url: `http://${name}.example.com:8080`,
    created_at: "2026-01-01T00:00:00.000Z",
    isp_tags: null,
    weight: 1,
    disabled: disabled ? 1 : 0,
  };
}

// 假 D1：SELECT 按表返回预置数据；写语句统一收集到 writes（不落库，也不做真实事务）
function stubEnv(opts: {
  nodes?: NodeRow[];
  groups?: { id: number; name: string; created_at: string }[];
  members?: { group_id: number; node_id: string; is_backup: number }[];
} = {}) {
  const writes: Stmt[] = [];
  const selectResults = (sql: string) => {
    if (sql.includes("FROM nodes")) return opts.nodes ?? [];
    if (sql.includes("FROM proxy_groups")) return opts.groups ?? [];
    if (sql.includes("FROM node_groups")) return opts.members ?? [];
    return [];
  };
  const db = {
    prepare(sql: string) {
      const stmt: FakeStmt = {
        sql,
        args: [],
        bind: (...args: unknown[]) => {
          stmt.args = args;
          return stmt;
        },
        all: async () => ({ success: true, results: selectResults(sql) }),
      };
      return stmt;
    },
    batch: async (stmts: FakeStmt[]) =>
      stmts.map((s) => {
        if (s.sql.trim().toUpperCase().startsWith("SELECT")) {
          return { success: true, results: selectResults(s.sql) };
        }
        writes.push({ sql: s.sql, args: s.args });
        return { success: true, results: [] };
      }),
  };
  return { env: { EMBY_DB: db } as unknown as Env, writes };
}

function req(body: unknown) {
  return { body } as unknown as Parameters<typeof handleUpdateNode>[0];
}

const has = (writes: Stmt[], prefix: string) =>
  writes.some((w) => w.sql.startsWith(prefix));

describe("handleUpdateNode 禁用节点自动移出代理组", () => {
  it("禁用时同批次删除 node_groups 关联", async () => {
    const { env, writes } = stubEnv({ nodes: [node("n1", "dash")] });
    const res = await handleUpdateNode(req({ disabled: true }), env, "n1");
    expect(res.status).toBe(200);
    expect(has(writes, "UPDATE nodes SET")).toBe(true);
    const del = writes.find((w) => w.sql.startsWith("DELETE FROM node_groups"));
    expect(del?.args).toEqual(["n1"]);
  });

  it("启用时不动组关联", async () => {
    const { env, writes } = stubEnv({ nodes: [node("n1", "dash", true)] });
    const res = await handleUpdateNode(req({ disabled: false }), env, "n1");
    expect(res.status).toBe(200);
    expect(has(writes, "UPDATE nodes SET")).toBe(true);
    expect(has(writes, "DELETE FROM node_groups")).toBe(false);
  });
});

describe("代理组成员维护", () => {
  const nodes = [node("n1", "dash"), node("n2", "hk", true)];

  it("创建组时拒绝禁用节点（主成员）", async () => {
    const { env, writes } = stubEnv({ nodes });
    const res = await handleCreateGroup(req({ name: "g1", node_ids: ["n2"] }), env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("已禁用节点不能加入组");
    expect(body.error).toContain("hk");
    expect(writes).toHaveLength(0);
  });

  it("更新组时拒绝禁用节点（备用）", async () => {
    const { env, writes } = stubEnv({
      nodes,
      groups: [{ id: 1, name: "g1", created_at: "2026-01-01T00:00:00.000Z" }],
      members: [{ group_id: 1, node_id: "n1", is_backup: 0 }],
    });
    const res = await handleUpdateGroup(req({ backup_node_ids: ["n2"] }), env, 1);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("已禁用节点不能加入组");
    expect(writes).toHaveLength(0);
  });

  it("成员变更走 DELETE 全量覆盖 + 重插", async () => {
    const { env, writes } = stubEnv({
      nodes: [node("n1", "dash"), node("n3", "jp")],
      groups: [{ id: 1, name: "g1", created_at: "2026-01-01T00:00:00.000Z" }],
      members: [{ group_id: 1, node_id: "n1", is_backup: 0 }],
    });
    const res = await handleUpdateGroup(req({ node_ids: ["n3"] }), env, 1);
    expect(res.status).toBe(200);
    const del = writes.find((w) => w.sql.startsWith("DELETE FROM node_groups"));
    expect(del?.args).toEqual([1]);
    const inserts = writes.filter((w) => w.sql.startsWith("INSERT INTO node_groups"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.args).toEqual(["n3", 1, 0]);
  });

  it("删除节点时清理组关联", async () => {
    const { env, writes } = stubEnv({ nodes: [node("n1", "dash")] });
    const res = await handleDeleteNode(env, "n1");
    expect(res.status).toBe(200);
    expect(has(writes, "DELETE FROM node_groups WHERE node_id")).toBe(true);
    expect(has(writes, "DELETE FROM nodes")).toBe(true);
  });
});
