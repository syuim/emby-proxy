import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  buildNewIpMessage,
  notifyNewIp,
  notifySkipReason,
  sendTelegramMessage,
  __resetNotifyStateForTests,
} from "./notify";
import type { Env } from "./types";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});
beforeEach(() => {
  __resetNotifyStateForTests();
});

function makeReq(ip?: string, ua = "TestUA/1.0", cf?: Record<string, unknown>): Request {
  const headers: Record<string, string> = { "User-Agent": ua };
  if (ip) headers["CF-Connecting-IP"] = ip;
  const req = new Request("https://proxy.example.com/emby/main/Users/abc", { headers });
  if (cf) (req as unknown as { cf?: Record<string, unknown> }).cf = cf;
  return req;
}

function collectCtx(): { ctx: ExecutionContext; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      tasks.push(p);
    },
  } as unknown as ExecutionContext;
  return { ctx, tasks };
}

// 假 D1：INSERT 返回指定 changes（默认 1=新 IP），config_meta 读返回配置值
function stubEnv(opts: { tgToken?: string; tgChat?: string; insertChanges?: number } = {}) {
  const calls = { inserts: 0, configReads: 0 };
  const db = {
    prepare(sql: string) {
      const stmt: any = {
        args: [] as unknown[],
        bind: (...args: unknown[]) => {
          stmt.args = args;
          return stmt;
        },
        run: async () => {
          if (sql.includes("INSERT INTO seen_ips")) {
            calls.inserts++;
            return { success: true, meta: { changes: opts.insertChanges ?? 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        first: async () => {
          if (sql.includes("FROM config_meta")) {
            calls.configReads++;
            return {
              tg_bot_token: opts.tgToken ?? "",
              tg_chat_id: opts.tgChat ?? "",
            };
          }
          return null;
        },
        all: async () => ({ success: true, results: [] }),
      };
      return stmt;
    },
  };
  return { env: { EMBY_DB: db } as unknown as Env, calls };
}

describe("buildNewIpMessage", () => {
  it("包含 IP / 目标 / 运营商中文标签 / ASN 组织 / 地区", () => {
    const text = buildNewIpMessage({
      ip: "1.2.3.4",
      target: "emby=main",
      method: "GET",
      path: "/emby/main/Users/abc",
      isp: "ct",
      asn: 4134,
      asOrganization: "CHINANET-BACKBONE",
      country: "CN",
      city: "Guangzhou",
      ua: "Emby/4.8",
      now: new Date("2026-09-14T12:00:00Z"),
    });
    expect(text).toContain("1.2.3.4");
    expect(text).toContain("emby=main");
    expect(text).toContain("电信");
    expect(text).toContain("AS4134");
    expect(text).toContain("CHINANET-BACKBONE");
    expect(text).toContain("CN Guangzhou");
    expect(text).toContain("GET /emby/main/Users/abc");
    expect(text).toContain("2026-09-14T12:00:00.000Z");
  });

  it("overseas 显示为海外，缺失 cf/UA 不崩且省略对应行", () => {
    const text = buildNewIpMessage({
      ip: "8.8.8.8",
      target: "地址访问 x.example.com",
      method: "GET",
      path: "/",
      isp: "overseas",
      now: new Date("2026-09-14T00:00:00Z"),
    });
    expect(text).toContain("海外");
    expect(text).not.toContain("UA:");
    expect(text).toContain("地址访问 x.example.com");
  });

  it("超长 UA 截断", () => {
    const text = buildNewIpMessage({
      ip: "1.1.1.1",
      target: "emby=main",
      method: "GET",
      path: "/",
      isp: "cu",
      ua: "U".repeat(300),
      now: new Date(),
    });
    expect(text).toContain("U".repeat(120) + "…");
    expect(text).not.toContain("U".repeat(121));
  });
});

describe("sendTelegramMessage", () => {
  it("成功：POST 到 bot sendMessage，携带 chat_id 与纯文本", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as any;
    const r = await sendTelegramMessage("123:ABC", "42", "hello");
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    const body = JSON.parse(String(init.body));
    expect(body.chat_id).toBe("42");
    expect(body.text).toBe("hello");
    expect(body.parse_mode).toBeUndefined();
  });

  it("TG 返回错误：透出 description", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 }),
    ) as any;
    const r = await sendTelegramMessage("123:ABC", "42", "hello");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("chat not found");
  });

  it("网络异常：不抛，返回 error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as any;
    const r = await sendTelegramMessage("123:ABC", "42", "hello");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("network down");
  });
});

describe("notifySkipReason", () => {
  it("淘宝/杭州阿里 AS37963 → taobao", () => {
    expect(notifySkipReason({ isp: "ct", asn: 37963, city: "Hangzhou" })).toBe("taobao");
  });

  it("联通 + 杭州 → unicom-hangzhou（大小写/空白容错）", () => {
    expect(notifySkipReason({ isp: "cu", asn: 4837, city: " Hangzhou " })).toBe(
      "unicom-hangzhou",
    );
  });

  it("联通非杭州 / 非联通杭州 / 缺城市 → 不忽略", () => {
    expect(notifySkipReason({ isp: "cu", asn: 4837, city: "Shaoxing" })).toBeNull();
    expect(notifySkipReason({ isp: "ct", asn: 4134, city: "Hangzhou" })).toBeNull();
    expect(notifySkipReason({ isp: "cu", asn: 4837 })).toBeNull();
  });
});

describe("notifyNewIp", () => {
  function mockOkFetch() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as any;
    return fetchMock;
  }

  it("新 IP：写 seen_ips 并发一条 TG", async () => {
    const { env, calls } = stubEnv({ tgToken: "123:ABC", tgChat: "42" });
    const fetchMock = mockOkFetch();
    const { ctx, tasks } = collectCtx();
    notifyNewIp(makeReq("1.2.3.4"), env, ctx, "emby=main");
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(calls.inserts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("同 isolate 内同 IP 第二次连入：不再打 D1 / 不再发", async () => {
    const { env, calls } = stubEnv({ tgToken: "123:ABC", tgChat: "42" });
    const fetchMock = mockOkFetch();
    const first = collectCtx();
    notifyNewIp(makeReq("1.2.3.4"), env, first.ctx, "emby=main");
    await Promise.all(first.tasks);
    const second = collectCtx();
    notifyNewIp(makeReq("1.2.3.4"), env, second.ctx, "emby=main");
    await Promise.all(second.tasks);
    expect(calls.inserts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("D1 判定已见 IP（changes=0）：不发 TG", async () => {
    const { env } = stubEnv({ tgToken: "123:ABC", tgChat: "42", insertChanges: 0 });
    const fetchMock = mockOkFetch();
    const { ctx, tasks } = collectCtx();
    notifyNewIp(makeReq("1.2.3.4"), env, ctx, "emby=main");
    await Promise.all(tasks);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("未配置 TG：不落库不发送", async () => {
    const { env, calls } = stubEnv();
    const fetchMock = mockOkFetch();
    const { ctx, tasks } = collectCtx();
    notifyNewIp(makeReq("1.2.3.4"), env, ctx, "emby=main");
    await Promise.all(tasks);
    expect(calls.inserts).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("缺 CF-Connecting-IP：整体跳过", async () => {
    const { env, calls } = stubEnv({ tgToken: "123:ABC", tgChat: "42" });
    const fetchMock = mockOkFetch();
    const { ctx, tasks } = collectCtx();
    notifyNewIp(makeReq(undefined), env, ctx, "emby=main");
    await Promise.all(tasks);
    expect(calls.inserts).toBe(0);
    expect(calls.configReads).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("淘宝 ASN（37963）：写 seen_ips 但不播报", async () => {
    const { env, calls } = stubEnv({ tgToken: "123:ABC", tgChat: "42" });
    const fetchMock = mockOkFetch();
    const { ctx, tasks } = collectCtx();
    notifyNewIp(
      makeReq("42.120.75.12", "Emby/4.8", { asn: 37963, city: "Hangzhou" }),
      env,
      ctx,
      "emby=main",
    );
    await Promise.all(tasks);
    expect(calls.inserts).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("杭州联通（AS4837 + Hangzhou）：写 seen_ips 但不播报", async () => {
    const { env, calls } = stubEnv({ tgToken: "123:ABC", tgChat: "42" });
    const fetchMock = mockOkFetch();
    const { ctx, tasks } = collectCtx();
    notifyNewIp(
      makeReq("2408:8440:b418:e2c2::1", "Emby/4.8", {
        asn: 4837,
        asOrganization: "CHINA UNICOM China169 Backbone",
        city: "Hangzhou",
      }),
      env,
      ctx,
      "emby=main",
    );
    await Promise.all(tasks);
    expect(calls.inserts).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("联通非杭州（Shaoxing）：照常播报", async () => {
    const { env } = stubEnv({ tgToken: "123:ABC", tgChat: "42" });
    const fetchMock = mockOkFetch();
    const { ctx, tasks } = collectCtx();
    notifyNewIp(
      makeReq("211.90.236.227", "Emby/4.8", {
        asn: 4837,
        asOrganization: "China United Telecommunications Corporation",
        city: "Shaoxing",
      }),
      env,
      ctx,
      "emby=main",
    );
    await Promise.all(tasks);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("无 ctx（测试直调场景）：任务仍会执行且不抛", async () => {
    const { env, calls } = stubEnv({ tgToken: "123:ABC", tgChat: "42" });
    const fetchMock = mockOkFetch();
    notifyNewIp(makeReq("9.9.9.9"), env, undefined, "emby=main");
    await vi.waitFor(() => expect(calls.inserts).toBe(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
