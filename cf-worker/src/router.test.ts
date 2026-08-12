import { describe, it, expect, afterEach, vi } from "vitest";
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
  doubanOriginChoice,
  doubanFwProbeUrl,
  doubanFwTtlMs,
  resetDoubanFwCache,
  handleDoubanRequest,
} from "./router";
import {
  DOUBAN_ORIGIN,
  DOUBAN_FW_ORIGIN,
  DOUBAN_FW_OK_TTL_MS,
  DOUBAN_FW_FAIL_TTL_BASE_MS,
} from "./constants";

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
  const douban = "http://rn.127315.xyz:31001";

  it("rewrites worker-origin image-proxy urls", () => {
    const body = `{"poster":"https://proxy.laoz.org/image-proxy?url=https%3A%2F%2Fimg1.doubanio.com%2Fx.jpg"}`;
    expect(rewriteDoubanBody(body, worker, douban)).toBe(
      `{"poster":"https://proxy.laoz.org/douban/image-proxy?url=https%3A%2F%2Fimg1.doubanio.com%2Fx.jpg"}`,
    );
  });

  it("rewrites direct-origin urls (X-Forwarded-Host stripped)", () => {
    const body = `{"poster":"http://rn.127315.xyz:31001/image-proxy?url=x"}`;
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
  const douban = "http://rn.127315.xyz:31001";

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
  const douban = "http://rn.127315.xyz:31001";

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

describe("doubanFwTtlMs", () => {
  it("alive is fixed 60s", () => {
    expect(doubanFwTtlMs(true, 0)).toBe(60_000);
    expect(doubanFwTtlMs(true, 10)).toBe(60_000);
  });

  it("fail backoff doubles and caps at 24h", () => {
    expect(doubanFwTtlMs(false, 0)).toBe(60_000);
    expect(doubanFwTtlMs(false, 1)).toBe(5 * 60_000);
    expect(doubanFwTtlMs(false, 2)).toBe(10 * 60_000);
    expect(doubanFwTtlMs(false, 3)).toBe(30 * 60_000);
    expect(doubanFwTtlMs(false, 4)).toBe(60 * 60_000);
    expect(doubanFwTtlMs(false, 5)).toBe(2 * 60 * 60_000);
    expect(doubanFwTtlMs(false, 6)).toBe(4 * 60 * 60_000);
    expect(doubanFwTtlMs(false, 7)).toBe(8 * 60 * 60_000);
    expect(doubanFwTtlMs(false, 8)).toBe(16 * 60 * 60_000);
    expect(doubanFwTtlMs(false, 9)).toBe(24 * 60 * 60_000);
    expect(doubanFwTtlMs(false, 20)).toBe(24 * 60 * 60_000);
  });
});

describe("doubanOriginChoice (probe cache)", () => {
  const probeUrl = doubanFwProbeUrl();
  const fwWithProfile = DOUBAN_FW_ORIGIN + "/suyu";

  afterEach(() => {
    resetDoubanFwCache();
    vi.restoreAllMocks();
  });

  it("returns fw origin with profile prefix when fw manifest is reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    );
    expect(await doubanOriginChoice()).toBe(fwWithProfile);
    expect(fetch).toHaveBeenCalledWith(probeUrl, expect.anything());
  });

  it("returns rn origin when fw manifest returns 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nf", { status: 404 })),
    );
    expect(await doubanOriginChoice()).toBe(DOUBAN_ORIGIN);
  });

  it("returns rn origin when fw probe throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await doubanOriginChoice()).toBe(DOUBAN_ORIGIN);
  });

  it("caches success for 15s without re-probing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await doubanOriginChoice()).toBe(fwWithProfile);
    expect(await doubanOriginChoice()).toBe(fwWithProfile);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-probes after success ttl elapses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("nf", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      expect(await doubanOriginChoice()).toBe(fwWithProfile);
      await vi.advanceTimersByTimeAsync(DOUBAN_FW_OK_TTL_MS + 1);
      expect(await doubanOriginChoice()).toBe(DOUBAN_ORIGIN);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies exponential backoff on repeated failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nf", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      // 第 1 次失败：ttl 5m
      expect(await doubanOriginChoice()).toBe(DOUBAN_ORIGIN);
      await vi.advanceTimersByTimeAsync(DOUBAN_FW_FAIL_TTL_BASE_MS - 1);
      expect(await doubanOriginChoice()).toBe(DOUBAN_ORIGIN); // 缓存内，不再探测
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2);
      expect(await doubanOriginChoice()).toBe(DOUBAN_ORIGIN); // 第 2 次探测仍失败
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // 第 2 次失败后 ttl 10m
      await vi.advanceTimersByTimeAsync(DOUBAN_FW_FAIL_TTL_BASE_MS * 2 - 1);
      expect(await doubanOriginChoice()).toBe(DOUBAN_ORIGIN); // 缓存内
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers after a failed streak: success resets fail count", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nf", { status: 404 }))
      .mockResolvedValueOnce(new Response("nf", { status: 404 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      expect(await doubanOriginChoice()).toBe(DOUBAN_ORIGIN); // fail 1
      await vi.advanceTimersByTimeAsync(DOUBAN_FW_FAIL_TTL_BASE_MS);
      expect(await doubanOriginChoice()).toBe(DOUBAN_ORIGIN); // fail 2
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(DOUBAN_FW_FAIL_TTL_BASE_MS * 2);
      expect(await doubanOriginChoice()).toBe(fwWithProfile); // 恢复
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // 恢复后：15s 内不探测，且失败计数清零（下一轮失败从 5m 重新开始）
      await vi.advanceTimersByTimeAsync(DOUBAN_FW_OK_TTL_MS - 1);
      expect(await doubanOriginChoice()).toBe(fwWithProfile);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("handleDoubanRequest 307 branch", () => {
  const fakeCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

  afterEach(() => {
    resetDoubanFwCache();
    vi.restoreAllMocks();
  });

  it("307 to fw origin + /suyu profile when fw reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    );
    const req = new Request("http://worker.local/douban/catalog/movie/movie_top250.json?skip=0");
    const resp = await handleDoubanRequest(req, fakeCtx);
    expect(resp.status).toBe(307);
    expect(resp.headers.get("Location")).toBe(
      "https://fw-douban.laoz.org/suyu/catalog/movie/movie_top250.json?skip=0",
    );
    // 307 分支只应有一次 fetch（探测），不反代
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to rn proxy when fw unreachable (no 307)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(new Response("nf", { status: 404 })) // 探测失败
        .mockResolvedValueOnce(
          new Response('{"metas":[]}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ), // 反代 rn
    );
    const req = new Request("http://worker.local/douban/catalog/movie/movie_top250.json?skip=0");
    const resp = await handleDoubanRequest(req, fakeCtx);
    expect(resp.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    const secondCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[0]).toBe(
      "http://rn.127315.xyz:31001/catalog/movie/movie_top250.json?skip=0",
    );
  });
});
