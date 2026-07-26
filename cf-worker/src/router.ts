import { RESERVED_NAMES, IMAGE_CACHE_MAX_AGE, IMAGE_CACHE_SWR, STRIP_AUTH_PARAMS, FORWARD_REQ_HEADERS } from "./constants";
import { readEmbys, readHealth, readNodes, writeEmbys } from "./storage";
import { buildSnapshot, pushSnapshotToAll } from "./sync";
import { mergeSyncResults } from "./health";
import type { EmbyRecord, Env, NodeRecord } from "./types";



export async function handleClientRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return notFound("missing emby name");
  }
  const embyName = segments[0]!;
  if (RESERVED_NAMES.has(embyName.toLowerCase())) {
    return notFound("reserved path");
  }

  const [embysKV, nodesKV] = await Promise.all([
    readEmbys(env),
    readNodes(env),
  ]);

  const emby = embysKV.embys.find((e) => e.name === embyName);
  if (!emby) {
    return notFound(`unknown emby '${embyName}'`);
  }

  const node = await chooseNode(env, emby, nodesKV.nodes);
  if (!node) {
    // 所有代理节点不可用 → 直连 emby backend
    const subpath = "/" + segments.slice(1).join("/");
    const target = buildTargetUrl(emby.backend_url, subpath, url.search);
    if (isCacheableImageRequest(request, path)) {
      return serveCachedImage(request, target, ctx);
    }
    return new Response(null, {
      status: 307,
      headers: { Location: target, "Cache-Control": "no-store" },
    });
  }

  const target = buildTargetUrl(node.public_url, path, url.search);

  if (isCacheableImageRequest(request, path)) {
    return serveCachedImage(request, target, ctx);
  }

  return new Response(null, {
    status: 307,
    headers: {
      Location: target,
      "Cache-Control": "no-store",
    },
  });
}

// ---------- Direct proxy (auto-register) ----------

export async function handleDirectRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const token = env.DIRECT_PROXY_TOKEN!;

  // Path: /<token>/<backend_url>
  // Stripping /<token>/ gives the full backend URL
  const prefix = "/" + token + "/";
  const backendUrlFull = path.startsWith(prefix) ? path.slice(prefix.length) : "";
  if (!backendUrlFull.startsWith("http://") && !backendUrlFull.startsWith("https://")) {
    return new Response("Bad Request: backend URL must start with http:// or https://", { status: 400 });
  }

  let backendOrigin: string;
  let subpath: string;
  try {
    const parsed = new URL(backendUrlFull);
    backendOrigin = parsed.origin;
    subpath = parsed.pathname;
    if (isPrivateHost(parsed.hostname)) {
      return new Response("Forbidden: backend URL points to a private or reserved address", { status: 403 });
    }
  } catch {
    return new Response("Bad Request: invalid backend URL", { status: 400 });
  }

  const [embysKV, nodesKV] = await Promise.all([readEmbys(env), readNodes(env)]);

  let emby = embysKV.embys.find((e) => e.backend_url === backendOrigin);
  if (!emby) {
    const anyNode = nodesKV.nodes[0];
    if (!anyNode) {
      return new Response("Bad Gateway: no node available", { status: 502 });
    }

    const name = await generateDirectEmbyName(backendOrigin);
    if (embysKV.embys.some((e) => e.name === name)) {
      const fresh = await readEmbys(env);
      emby = fresh.embys.find((e) => e.backend_url === backendOrigin);
      if (!emby) {
        return new Response("Internal Server Error: name collision", { status: 500 });
      }
    }

    if (!emby) {
      emby = {
        name,
        backend_url: backendOrigin,
        node_id: anyNode.id,
        created_at: new Date().toISOString(),
      };
      embysKV.version += 1;
      embysKV.embys.push(emby);
      await writeEmbys(env, embysKV);

      ctx.waitUntil((async () => {
        const snapshot = buildSnapshot(embysKV);
        const results = await pushSnapshotToAll(nodesKV.nodes, snapshot, env.EMBY_SYNC_TOKEN, "direct-register");
        const health = await readHealth(env);
        await mergeSyncResults(env, health, results);
      })());
    }
  }

  const node = await chooseNode(env, emby, nodesKV.nodes);
  if (!node) {
    // 直连模式
    const target = buildTargetUrl(emby.backend_url, subpath, url.search);
    return new Response(null, {
      status: 307,
      headers: { Location: target, "Cache-Control": "no-store" },
    });
  }

  const nodePath = "/" + emby.name + subpath;
  const target = buildTargetUrl(node.public_url, nodePath, url.search);

  return new Response(null, {
    status: 307,
    headers: { Location: target, "Cache-Control": "no-store" },
  });
}

async function generateDirectEmbyName(backendUrl: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(backendUrl));
  const hex = Array.from(new Uint8Array(hash, 0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "d_" + hex;
}

// ponytail: simple IP check for SSRF at cf-worker level. Hostname-based SSRF is caught by proxy-go's isDangerousRedirect.
export function isPrivateHost(host: string): boolean {
  // Strip IPv6 brackets
  const ip = host.startsWith("[") ? host.slice(1, -1) : host;
  // IPv4 check
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 0) return true;
  }
  // Common IPv6 private/reserved
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  return false;
}

export function isCacheableImageRequest(request: Request, path: string): boolean {
  if (request.method !== "GET") return false;
  if (request.headers.has("Range")) return false;
  return /\/Images\//i.test(path);
}

async function serveCachedImage(
  request: Request,
  target: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const cache = caches.default;
  const cacheKey = buildImageCacheKey(target);

  const hit = await cache.match(cacheKey);
  if (hit) {
    const resp = new Response(hit.body, hit);
    resp.headers.set("X-Cache", "HIT");
    return resp;
  }

  const upstream = await fetch(target, {
    method: "GET",
    headers: filterUpstreamHeaders(request.headers),
    redirect: "follow",
  });

  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  }

  const resp = new Response(upstream.body, upstream);
  resp.headers.set(
    "Cache-Control",
    `public, max-age=${IMAGE_CACHE_MAX_AGE}, stale-while-revalidate=${IMAGE_CACHE_SWR}`,
  );
  resp.headers.delete("Set-Cookie");
  resp.headers.delete("Pragma");
  resp.headers.set("X-Cache", "MISS");

  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

export function buildImageCacheKey(target: string): Request {
  const u = new URL(target);
  for (const p of STRIP_AUTH_PARAMS) {
    u.searchParams.delete(p);
  }
  return new Request(u.toString(), { method: "GET" });
}

function filterUpstreamHeaders(src: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of src) {
    if (FORWARD_REQ_HEADERS.has(k.toLowerCase())) {
      out.set(k, v);
    }
  }
  return out;
}

async function chooseNode(
  env: Env,
  emby: EmbyRecord,
  nodes: NodeRecord[],
): Promise<NodeRecord | null> {
  const health = await readHealth(env);
  const primary = nodes.find((n) => n.id === emby.node_id);

  if (primary && health.nodes[primary.id]?.healthy) {
    return primary;
  }

  // 主节点不健康：从其他节点中随机挑一个健康的
  const fallbacks = nodes
    .filter((n) => n.id !== emby.node_id && health.nodes[n.id]?.healthy);
  if (fallbacks.length > 0) {
    const pick = fallbacks[Math.floor(Math.random() * fallbacks.length)]!;
    console.warn(
      `node '${emby.node_id}' unhealthy for emby='${emby.name}', picking fallback='${pick.id}'`,
    );
    return pick;
  }

  // 全部不健康：由调用方兜底直连 backend_url
  return null;
}

export function buildTargetUrl(publicUrl: string, path: string, search: string): string {
  const base = publicUrl.replace(/\/$/, "");
  const normalized = normalizePath(path);
  return `${base}${normalized}${search}`;
}

// ponytail: collapse .. segments to prevent path traversal past the emby prefix.
// Browser clients already normalize, but raw HTTP clients may send unnormalized paths.
export function normalizePath(path: string): string {
  const parts = path.split("/");
  const result: string[] = [];
  for (const p of parts) {
    if (p === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") {
        result.pop();
      }
    } else if (p !== "" && p !== ".") {
      result.push(p);
    }
  }
  return "/" + result.join("/");
}

function notFound(reason: string): Response {
  return new Response(`Not Found: ${reason}`, {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}
