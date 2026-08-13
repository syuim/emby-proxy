import { describe, it, expect } from "vitest";
import {
  isPrivateHost,
  normalizePath,
  isCacheableImageRequest,
  buildTargetUrl,
  buildImageCacheKey,
  isDoubanCacheablePath,
  rewriteDoubanLocation,
  rewriteDoubanBody,
  rewriteDoubanHtml,
  rewriteDoubanJs,
  isTmdbImageSubpath,
} from "./router";

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

describe("isCacheableImageRequest", () => {
  function makeReq(method: string, headers: Record<string, string> = {}): Request {
    return new Request("http://x.com/test", { method, headers });
  }

  it("accepts GET /Images/ without Range", () => {
    expect(isCacheableImageRequest(makeReq("GET"), "/emby/Images/Primary")).toBe(true);
  });

  it("rejects non-GET", () => {
    expect(isCacheableImageRequest(makeReq("POST"), "/emby/Images/Primary")).toBe(false);
  });

  it("rejects Range header", () => {
    expect(isCacheableImageRequest(makeReq("GET", { Range: "bytes=0-100" }), "/emby/Images/Primary")).toBe(false);
  });

  it("rejects non-Images path", () => {
    expect(isCacheableImageRequest(makeReq("GET"), "/emby/Videos/1")).toBe(false);
  });

  it("is case-insensitive on path", () => {
    expect(isCacheableImageRequest(makeReq("GET"), "/emby/images/primary")).toBe(true);
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

describe("buildImageCacheKey", () => {
  it("strips auth params from cache key", () => {
    const req = buildImageCacheKey(
      "http://node:8080/emby/Images/Primary?api_key=secret&X-Emby-Token=tok&width=300",
    );
    const url = new URL(req.url);
    expect(url.searchParams.has("api_key")).toBe(false);
    expect(url.searchParams.has("X-Emby-Token")).toBe(false);
    expect(url.searchParams.get("width")).toBe("300");
  });

  it("strips X-MediaBrowser-Token", () => {
    const req = buildImageCacheKey(
      "http://node:8080/emby/Images/Primary?X-MediaBrowser-Token=abc",
    );
    const url = new URL(req.url);
    expect(url.searchParams.has("X-MediaBrowser-Token")).toBe(false);
  });

  it("uses GET method", () => {
    const req = buildImageCacheKey("http://node:8080/emby/Images/Primary");
    expect(req.method).toBe("GET");
  });
});

describe("rewriteDoubanLocation", () => {
  const base = "https://fw-douban.laoz.org/";

  it("prefixes relative locations", () => {
    expect(rewriteDoubanLocation("/configure", base)).toBe("/douban/configure");
    expect(rewriteDoubanLocation("/login", base)).toBe("/douban/login");
  });

  it("rewrites absolute locations on the douban origin", () => {
    expect(rewriteDoubanLocation("https://fw-douban.laoz.org/login?next=x", base)).toBe(
      "/douban/login?next=x",
    );
  });

  it("keeps external links untouched", () => {
    expect(rewriteDoubanLocation("https://www.douban.com/", base)).toBe(
      "https://www.douban.com/",
    );
    expect(rewriteDoubanLocation("https://www.themoviedb.org/movie/1", base)).toBe(
      "https://www.themoviedb.org/movie/1",
    );
  });

  it("preserves query", () => {
    expect(rewriteDoubanLocation("/configure?tab=1", base)).toBe("/douban/configure?tab=1");
  });

  it("returns null for missing location", () => {
    expect(rewriteDoubanLocation(null, base)).toBeNull();
  });
});

describe("rewriteDoubanBody", () => {
  const worker = "https://proxy.laoz.org";
  const douban = "http://de.127315.xyz:31001";

  it("rewrites worker-origin image-proxy urls", () => {
    const body = `{"poster":"https://proxy.laoz.org/image-proxy?url=https%3A%2F%2Fimg1.doubanio.com%2Fx.jpg"}`;
    expect(rewriteDoubanBody(body, worker, douban)).toBe(
      `{"poster":"https://proxy.laoz.org/douban/image-proxy?url=https%3A%2F%2Fimg1.doubanio.com%2Fx.jpg"}`,
    );
  });

  it("rewrites direct-origin urls (X-Forwarded-Host stripped)", () => {
    const body = `{"poster":"http://de.127315.xyz:31001/image-proxy?url=x"}`;
    expect(rewriteDoubanBody(body, worker, douban)).toBe(
      `{"poster":"https://proxy.laoz.org/douban/image-proxy?url=x"}`,
    );
  });

  it("rewrites manifestUrl from configure save", () => {
    const body = `{"success":true,"manifestUrl":"https://proxy.laoz.org/suyu/manifest.json"}`;
    expect(rewriteDoubanBody(body, worker, douban)).toBe(
      `{"success":true,"manifestUrl":"https://proxy.laoz.org/douban/suyu/manifest.json"}`,
    );
  });

  it("rewrites http-scheme worker-origin urls (X-Forwarded-Proto missing)", () => {
    const body = `{"success":true,"manifestUrl":"http://proxy.laoz.org/suyu/manifest.json"}`;
    expect(rewriteDoubanBody(body, worker, douban)).toBe(
      `{"success":true,"manifestUrl":"https://proxy.laoz.org/douban/suyu/manifest.json"}`,
    );
  });

  it("does not double-prefix already-prefixed urls", () => {
    const body = `{"url":"https://proxy.laoz.org/douban/image-proxy?url=x"}`;
    expect(rewriteDoubanBody(body, worker, douban)).toBe(body);
  });

  it("leaves encoded query strings untouched", () => {
    const body = `{"url":"https://proxy.laoz.org/image-proxy?url=https%3A%2F%2Fexample.com%2Fa%2Fimage-proxy%2Fb.jpg"}`;
    expect(rewriteDoubanBody(body, worker, douban)).toBe(
      `{"url":"https://proxy.laoz.org/douban/image-proxy?url=https%3A%2F%2Fexample.com%2Fa%2Fimage-proxy%2Fb.jpg"}`,
    );
  });

  it("is a no-op without matches", () => {
    const body = `{"id":"douban:1","links":[{"url":"https://www.douban.com/"}]}`;
    expect(rewriteDoubanBody(body, worker, douban)).toBe(body);
  });
});

describe("rewriteDoubanHtml", () => {
  const worker = "https://proxy.laoz.org";
  const douban = "http://de.127315.xyz:31001";

  it("prefixes root-relative form action", () => {
    const html = `<form method="POST" action="/login">`;
    expect(rewriteDoubanHtml(html, worker, douban)).toBe(
      `<form method="POST" action="/douban/login">`,
    );
  });

  it("prefixes root-relative asset and icon links", () => {
    const html =
      `<link rel="stylesheet" href="/assets/foo.css">` +
      `<script src="/assets/bar.js"></script>` +
      `<link rel="icon" href="/icon.png">`;
    expect(rewriteDoubanHtml(html, worker, douban)).toBe(
      `<link rel="stylesheet" href="/douban/assets/foo.css">` +
        `<script src="/douban/assets/bar.js"></script>` +
        `<link rel="icon" href="/douban/icon.png">`,
    );
  });

  it("keeps external and protocol-relative urls", () => {
    const html =
      `<a href="https://github.com/x">GitHub</a>` +
      `<script src="https://cdn.example.com/lib.js"></script>` +
      `<script src="//cdn.example.com/lib2.js"></script>`;
    expect(rewriteDoubanHtml(html, worker, douban)).toBe(html);
  });

  it("rewrites manifestUrl inside __INITIAL_DATA__", () => {
    const html =
      `<script id="__INITIAL_DATA__" type="application/json">` +
      `{"manifestUrl":"https://proxy.laoz.org/suyu/manifest.json"}</script>`;
    expect(rewriteDoubanHtml(html, worker, douban)).toBe(
      `<script id="__INITIAL_DATA__" type="application/json">` +
        `{"manifestUrl":"https://proxy.laoz.org/douban/suyu/manifest.json"}</script>`,
    );
  });
});

describe("rewriteDoubanJs", () => {
  const worker = "https://proxy.laoz.org";
  const douban = "http://de.127315.xyz:31001";

  it("prefixes fetch configure call", () => {
    const js = `const res=await fetch(\`/configure\${p?"?"+p:""}\`,{method:"POST"});`;
    expect(rewriteDoubanJs(js, worker, douban)).toBe(
      `const res=await fetch(\`/douban/configure\${p?"?"+p:""}\`,{method:"POST"});`,
    );
  });

  it("prefixes double-quoted configure path", () => {
    const js = `fetch("/configure",{method:"POST"})`;
    expect(rewriteDoubanJs(js, worker, douban)).toBe(
      `fetch("/douban/configure",{method:"POST"})`,
    );
  });

  it("does not touch configure-like words", () => {
    const js = `const x="/configured";`;
    expect(rewriteDoubanJs(js, worker, douban)).toBe(js);
  });

  it("keeps replaceState template unprefixed", () => {
    const js = `window.history.replaceState(null,"",\`/\${configId}/configure\`);`;
    expect(rewriteDoubanJs(js, worker, douban)).toBe(js);
  });
});

describe("isDoubanCacheablePath", () => {
  it.each([
    ["/image-proxy?url=x", true],
    ["/image-proxy", true],
    ["/assets/index-abc123.js", true],
  ])("caches %s", (path, expected) => {
    expect(isDoubanCacheablePath(path)).toBe(expected);
  });

  it.each([
    ["/catalog/movie/top250.json", false],
    ["/manifest.json", false],
    ["/meta/movie/douban:1.json", false],
    ["/configure", false],
    ["/login", false],
  ])("does not cache %s", (path, expected) => {
    expect(isDoubanCacheablePath(path)).toBe(expected);
  });
});
