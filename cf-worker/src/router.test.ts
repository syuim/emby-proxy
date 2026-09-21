import { describe, it, expect, afterEach } from "vitest";
import {
  isPrivateHost,
  normalizePath,
  buildTargetUrl,
  rewriteM3u8Urls,
  isTmdbImageSubpath,
  handleDoubanApiRequest,
  doubanApiSubpath,
  registerDirectEmby,
  generateDirectEmbyName,
} from "./router";
import { DOUBAN_API_BASE_PATH } from "./constants";
import type { Env } from "./types";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("isPrivateHost", () => {
  it.each([
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["127.0.0.1", true],
    ["169.254.1.1", true],
    ["192.168.0.1", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["0.0.0.0", true],
    ["::1", true],
    ["[::1]", true],
    ["fe80::1", true],
    ["fd12:3456::1", true],
    ["fc00::1", true],
    ["localhost", true],
    ["foo.localhost", true],
    ["metadata.google.internal", true],
    ["instance.metadata.google.internal", true],
    ["[::ffff:127.0.0.1]", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["[::ffff:7f00:1]", true],
    ["100.64.0.1", true],
    ["100.127.255.255", true],
    ["192.0.0.192", true],
    ["192.0.0.255", true],
    ["198.18.0.1", true],
    ["224.0.0.1", true],
    ["240.0.0.1", true],
  ])("blocks %s", (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });

  it.each([
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["172.32.0.1", false],
    ["172.15.0.1", false],
    ["11.0.0.1", false],
    ["example.com", false],
    ["my-emby.local", false],
    ["2001:db8::1", false],
    ["fcbank.com", false],
    ["fd-example.com", false],
    ["100.128.0.1", false],
    ["100.63.255.255", false],
    ["192.0.1.1", false],
    ["198.17.0.1", false],
    ["198.20.0.1", false],
  ])("allows %s", (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });
});

describe("normalizePath", () => {
  it("keeps simple paths", () => {
    expect(normalizePath("/emby/Videos/1")).toBe("/emby/Videos/1");
  });

  it("collapses .. segments", () => {
    expect(normalizePath("/emby/../admin")).toBe("/admin");
    expect(normalizePath("/a/b/../c")).toBe("/a/c");
  });

  it("does not traverse above root", () => {
    expect(normalizePath("/../etc/passwd")).toBe("/etc/passwd");
    expect(normalizePath("/a/../../b")).toBe("/b");
  });

  it("ignores . segments", () => {
    expect(normalizePath("/a/./b")).toBe("/a/b");
  });

  it("handles empty path", () => {
    expect(normalizePath("/")).toBe("/");
  });
});

describe("isTmdbImageSubpath", () => {
  it("accepts standard TMDB image paths", () => {
    expect(isTmdbImageSubpath("/t/p/original/abc123.jpg")).toBe(true);
    expect(isTmdbImageSubpath("/t/p/w500/abc123.png")).toBe(true);
  });

  it("rejects API paths", () => {
    expect(isTmdbImageSubpath("/3/movie/123")).toBe(false);
    expect(isTmdbImageSubpath("/3/search/movie")).toBe(false);
  });

  it("rejects edge cases", () => {
    expect(isTmdbImageSubpath("/t/p")).toBe(false);
    expect(isTmdbImageSubpath("/t/p/other/abc")).toBe(true); // /t/p/ 下任何子路径都视为图片
    expect(isTmdbImageSubpath("/")).toBe(false);
  });
});

describe("buildTargetUrl", () => {
  it("joins base + path + search", () => {
    expect(buildTargetUrl("http://node:8080", "/emby/Videos", "?id=1")).toBe(
      "http://node:8080/emby/Videos?id=1",
    );
  });

  it("strips trailing slash from base", () => {
    expect(buildTargetUrl("http://node:8080/", "/emby/Videos", "")).toBe(
      "http://node:8080/emby/Videos",
    );
  });

  it("normalizes path traversal in target", () => {
    expect(buildTargetUrl("http://node:8080", "/emby/../../secret", "")).toBe(
      "http://node:8080/secret",
    );
  });
});

describe("rewriteM3u8Urls", () => {
  const rewrite = (raw: string) => `W(${raw})`;

  it("rewrites plain segment lines", () => {
    expect(rewriteM3u8Urls("#EXTINF:5,\nhttp://cdn.example.com/seg.ts\n", rewrite)).toBe(
      "#EXTINF:5,\nW(http://cdn.example.com/seg.ts)\n",
    );
  });

  it("does not swallow quotes in EXT-X-KEY", () => {
    const input = `#EXT-X-KEY:METHOD=AES-128,URI="https://emby.example.com/key?tok=1",IV=0x0`;
    expect(rewriteM3u8Urls(input, rewrite)).toBe(
      `#EXT-X-KEY:METHOD=AES-128,URI="W(https://emby.example.com/key?tok=1)",IV=0x0`,
    );
  });

  it("does not swallow quotes in EXT-X-MAP", () => {
    const input = `#EXT-X-MAP:URI="https://cdn.example.com/init.mp4"`;
    expect(rewriteM3u8Urls(input, rewrite)).toBe(
      `#EXT-X-MAP:URI="W(https://cdn.example.com/init.mp4)"`,
    );
  });

  it("leaves text without URLs untouched", () => {
    const input = "#EXTM3U\n#EXT-X-VERSION:3\n";
    expect(rewriteM3u8Urls(input, rewrite)).toBe(input);
  });
});

describe("douban api alias", () => {
  it("extracts the subpath after /doubanapi (input is a bare pathname)", () => {
    expect(doubanApiSubpath(`${DOUBAN_API_BASE_PATH}/catalog/movie/top250.json`)).toBe(
      "/catalog/movie/top250.json",
    );
    expect(doubanApiSubpath(`${DOUBAN_API_BASE_PATH}/catalog`)).toBe("/catalog");
  });

  it("maps bare /doubanapi to the record root", () => {
    expect(doubanApiSubpath(`${DOUBAN_API_BASE_PATH}`)).toBe("/");
    expect(doubanApiSubpath(`${DOUBAN_API_BASE_PATH}/`)).toBe("/");
  });

  it("answers OPTIONS preflight locally with CORS", async () => {
    const resp = await handleDoubanApiRequest(
      new Request(`https://proxy.laoz.org${DOUBAN_API_BASE_PATH}/catalog`, { method: "OPTIONS" }),
      null as any,
    );
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("registerDirectEmby", () => {
  interface EmbyRow {
    name: string;
    backend_url: string;
    created_at: string;
    group_id: number | null;
  }

  // 极简 D1 mock：只实现 registerDirectEmby 用到的两条 SQL，INSERT 互斥语义与真实 D1 一致
  function makeEmbyDb(rows: EmbyRow[]) {
    const db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind(...a: unknown[]) {
            args = a;
            return stmt;
          },
          async run() {
            if (sql.startsWith("INSERT INTO embys")) {
              const [name, backend_url, created_at] = args as string[];
              if (rows.some((r) => r.name === name)) return { meta: { changes: 0 } };
              rows.push({ name: name!, backend_url: backend_url!, created_at: created_at!, group_id: null });
              return { meta: { changes: 1 } };
            }
            throw new Error("unexpected sql: " + sql);
          },
          async first() {
            if (sql.startsWith("SELECT name, backend_url, group_id, created_at FROM embys WHERE backend_url")) {
              return rows.find((r) => r.backend_url === args[0]) ?? null;
            }
            throw new Error("unexpected sql: " + sql);
          },
        };
        return stmt;
      },
    } as unknown as D1Database;
    return { db, rows };
  }

  function envOf(db: D1Database): Env {
    return { EMBY_DB: db, ADMIN_TOKEN: "t", EMBY_SYNC_TOKEN: "t" };
  }

  const origin = "https://emby.example.com";

  it("首次访问注册一条 d_<hash> 记录", async () => {
    const { db, rows } = makeEmbyDb([]);
    const rec = await registerDirectEmby(envOf(db), origin);
    expect(rec?.name).toBe(await generateDirectEmbyName(origin, 0));
    expect(rec?.backend_url).toBe(origin);
    expect(rec?.group_id).toBeNull();
    expect(rows).toHaveLength(1);
  });

  it("并发首访同一后端只落一条记录（撞名回查复用，不再插 -1 后缀）", async () => {
    const { db, rows } = makeEmbyDb([]);
    const [a, b] = await Promise.all([
      registerDirectEmby(envOf(db), origin),
      registerDirectEmby(envOf(db), origin),
    ]);
    const expected = await generateDirectEmbyName(origin, 0);
    expect(rows).toHaveLength(1);
    expect(a?.name).toBe(expected);
    expect(b?.name).toBe(expected);
  });

  it("backend_url 已有记录（并发已写入）时按 origin 回查复用", async () => {
    const existing = {
      name: await generateDirectEmbyName(origin, 0),
      backend_url: origin,
      created_at: "t0",
      group_id: 7,
    };
    const { db, rows } = makeEmbyDb([existing]);
    const rec = await registerDirectEmby(envOf(db), origin);
    expect(rec).toEqual(existing);
    expect(rows).toHaveLength(1);
  });

  it("name 被其它 origin 占用（真 hash 撞名）时才换 -1 后缀", async () => {
    const taken = {
      name: await generateDirectEmbyName(origin, 0),
      backend_url: "https://other.example.com",
      created_at: "t0",
      group_id: null,
    };
    const { db, rows } = makeEmbyDb([taken]);
    const rec = await registerDirectEmby(envOf(db), origin);
    expect(rec?.name).toBe(await generateDirectEmbyName(origin, 1));
    expect(rec?.backend_url).toBe(origin);
    expect(rows).toHaveLength(2);
  });
});
