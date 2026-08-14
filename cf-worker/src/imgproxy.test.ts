import { describe, it, expect, afterEach, vi } from "vitest";
import { handleUrlRequest, handleImgRequest } from "./imgproxy";
import { URL_BASE_PATH } from "./constants";

// /url 与 /img 共用同一实现（handleUrlRequest → handleImgRequest），
// 此处验证 /url 入口的通用 URL 代理行为与 /img 一致。

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function mockFetch(status: number, body: string, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(body, { status, headers }));
}

describe("handleUrlRequest", () => {
  it("proxies a GET url via /url", async () => {
    const mf = mockFetch(200, "hello", { "Content-Type": "text/plain" });
    globalThis.fetch = mf as any;

    const req = new Request(`https://proxy.laoz.org${URL_BASE_PATH}?url=${encodeURIComponent("https://api.example.com/data")}`);
    const resp = await handleUrlRequest(req, {} as any);

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("hello");
    // fetch 以 URL string 为第一参；首个调用可能是 Referer 规则文件加载，
    // 只要存在一次对目标 URL 的请求即可
    const urls = mf.mock.calls.map((c) => String((c as unknown as [string])[0]));
    expect(urls).toContain("https://api.example.com/data");
  });

  it("rejects missing url", async () => {
    const req = new Request(`https://proxy.laoz.org${URL_BASE_PATH}`);
    const resp = await handleUrlRequest(req, {} as any);
    expect(resp.status).toBe(400);
  });

  it("rejects private target", async () => {
    const req = new Request(`https://proxy.laoz.org${URL_BASE_PATH}?url=${encodeURIComponent("http://10.0.0.1/")}`);
    const resp = await handleUrlRequest(req, {} as any);
    expect(resp.status).toBe(403);
  });

  it("rejects self-proxy target", async () => {
    const req = new Request(`https://proxy.laoz.org${URL_BASE_PATH}?url=${encodeURIComponent("https://proxy.laoz.org/emby/admin")}`);
    const resp = await handleUrlRequest(req, {} as any);
    expect(resp.status).toBe(400);
  });

  it("handles /url and /img identically", async () => {
    const mf = mockFetch(200, "x");
    globalThis.fetch = mf as any;

    const reqUrl = new Request(`https://proxy.laoz.org${URL_BASE_PATH}?url=${encodeURIComponent("https://api.example.com/")}`);
    const reqImg = new Request(`https://proxy.laoz.org/img?url=${encodeURIComponent("https://api.example.com/")}`);
    const [r1, r2] = await Promise.all([handleUrlRequest(reqUrl, {} as any), handleImgRequest(reqImg, {} as any)]);
    expect(r1.status).toBe(r2.status);
    expect(await r1.text()).toBe(await r2.text());
  });

  it("sends movie.douban.com referer for doubanio image targets", async () => {
    const mf = mockFetch(200, "img");
    globalThis.fetch = mf as any;

    const req = new Request(
      `https://proxy.laoz.org${URL_BASE_PATH}?url=${encodeURIComponent("https://img9.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg")}`,
    );
    const resp = await handleUrlRequest(req, {} as any);
    expect(resp.status).toBe(200);

    const calls = mf.mock.calls.map((c) => c as unknown as [string, RequestInit]);
    const target = calls.find((c) => String(c[0]).includes("img9.doubanio.com"));
    expect(target).toBeDefined();
    expect(target![1].headers).toMatchObject({ Referer: "https://movie.douban.com/" });
  });
});
