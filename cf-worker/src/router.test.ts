import { describe, it, expect } from "vitest";
import {
  isPrivateHost,
  normalizePath,
  isCacheableImageRequest,
  buildTargetUrl,
  buildImageCacheKey,
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
