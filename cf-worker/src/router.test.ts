import { describe, it, expect, afterEach } from "vitest";
import {
  isPrivateHost,
  normalizePath,
  buildTargetUrl,
  rewriteM3u8Urls,
  isTmdbImageSubpath,
  handleDoubanApiRequest,
  doubanApiSubpath,
} from "./router";
import { DOUBAN_API_BASE_PATH } from "./constants";

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
