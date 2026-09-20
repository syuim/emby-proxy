import { describe, it, expect } from "vitest";
import { handleUpdateNode } from "./handlers";
import type { Env } from "../types";

type Stmt = { sql: string; args: unknown[] };
type FakeStmt = Stmt & {
  bind: (...args: unknown[]) => FakeStmt;
  all: () => Promise<unknown>;
};

// 仅覆盖 handleUpdateNode 触及的 SQL：nodes 读、nodes UPDATE、node_groups DELETE
function stubEnv(currentDisabled: boolean) {
  const batches: Stmt[][] = [];
  const nodeRow = {
    id: "n1",
    name: "dash",
    public_url: "http://dash.example.com:8080",
    created_at: "2026-01-01T00:00:00.000Z",
    isp_tags: '["ct"]',
    weight: 2,
    disabled: currentDisabled ? 1 : 0,
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
        all: async () => ({ success: true, results: [nodeRow] }),
      };
      return stmt;
    },
    batch: async (stmts: Stmt[]) => {
      batches.push(stmts);
      return [];
    },
  };
  return { env: { EMBY_DB: db } as unknown as Env, batches };
}

function req(body: unknown) {
  return { body } as unknown as Parameters<typeof handleUpdateNode>[0];
}

describe("handleUpdateNode 禁用节点自动移出代理组", () => {
  it("禁用时同批次删除 node_groups 关联", async () => {
    const { env, batches } = stubEnv(false);
    const res = await handleUpdateNode(req({ disabled: true }), env, "n1");
    expect(res.status).toBe(200);
    const sqls = batches.flat().map((s) => s.sql);
    expect(sqls.some((s) => s.startsWith("UPDATE nodes SET"))).toBe(true);
    const del = batches.flat().find((s) => s.sql.startsWith("DELETE FROM node_groups"));
    expect(del?.args).toEqual(["n1"]);
  });

  it("启用时不动组关联", async () => {
    const { env, batches } = stubEnv(true);
    const res = await handleUpdateNode(req({ disabled: false }), env, "n1");
    expect(res.status).toBe(200);
    const sqls = batches.flat().map((s) => s.sql);
    expect(sqls.some((s) => s.startsWith("UPDATE nodes SET"))).toBe(true);
    expect(sqls.some((s) => s.startsWith("DELETE FROM node_groups"))).toBe(false);
  });
});
