import { EMBY_BASE_PATH, HEALTH_PROBE_TIMEOUT_MS, LOCAL_NODE_ID, NODE_HEALTH_PATH, RESERVED_NAMES, IMAGE_CACHE_MAX_AGE, IMAGE_CACHE_SWR, STRIP_AUTH_PARAMS, FORWARD_REQ_HEADERS } from "./constants";
import { readEmbys, readHealth, readNodes, writeEmbys } from "./storage";
import { buildSnapshot, pushSnapshotToAll } from "./sync";
import { immediateProbe, mergeSyncResults } from "./health";
import type { EmbyRecord, Env, NodeRecord } from "./types";



export async function handleClientRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  void serveCachedImage; // 函数保留，恢复图片缓存时需要
  const url = new URL(request.url);
  const path = url.pathname;

  const segments = path.split("/").filter(Boolean); // ["emby", <name>, ...subpath]
  const embyName = segments[1];
  if (!embyName) {
    return notFound("missing emby name");
  }
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

  const subpath = "/" + segments.slice(2).join("/");

  // Worker 本地代理：不 307，Worker 直接 fetch 后端回传
  if (emby.node_id === LOCAL_NODE_ID) {
    return proxyLocal(
      request,
      buildTargetUrl(emby.backend_url, subpath, url.search),
      emby.name,
      emby.backend_url,
    );
  }

  const node = await chooseNode(env, emby, nodesKV.nodes, ctx);
  if (!node) {
    // 所有代理节点不可用 → 直连 emby backend
    const target = buildTargetUrl(emby.backend_url, subpath, url.search);
    // 图片缓存已注释，图片/视频统一走 307 节点代理
    // if (isCacheableImageRequest(request, path)) {
    //   return serveCachedImage(request, target, ctx);
    // }
    return new Response(null, {
      status: 307,
      headers: { Location: target, "Cache-Control": "no-store" },
    });
  }

  // 节点协议路径不含 /emby 前缀：/<name>/subpath
  const target = buildTargetUrl(node.public_url, "/" + emby.name + subpath, url.search);

  // 图片缓存已注释，图片/视频统一走 307 节点代理
  // if (isCacheableImageRequest(request, path)) {
  //   return serveCachedImage(request, target, ctx);
  // }

  return new Response(null, {
    status: 307,
    headers: {
      Location: target,
      "Cache-Control": "no-store",
    },
  });
}

// ---------- Worker 本地代理引擎 ----------
// 全程 Worker 中转：客户端只看到 Worker 域名。IP 透传固定 strict 模式（防 403）。
// 改写规则：同源（emby 后端自身）→ 名称形式 /emby/<name>/path；
// 跨域（CDN 直链）→ 编码地址形式 /emby/<encodeURIComponent(url)>。

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const STATIC_ASSET_RE =
  /\.(jpg|jpeg|gif|png|svg|ico|webp|js|css|woff2?|ttf|otf|map|webmanifest|srt|ass|vtt|sub)$/i;
const EMBY_IMAGE_PATH_RE = /(\/Images\/|\/Icons\/|\/Branding\/|\/emby\/covers\/)/i;

async function proxyLocal(
  request: Request,
  target: string,
  prefixName: string,
  backendOrigin: string,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response("Bad Gateway: invalid target URL", { status: 502 });
  }
  if (isPrivateHost(targetUrl.hostname)) {
    return new Response("Forbidden: target points to a private or reserved address", {
      status: 403,
    });
  }

  // strict：抹 CF/代理头 + 对齐 Origin/Referer + 透传真实 IP
  const realIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0]!.trim();
  const headers = new Headers(request.headers);
  for (const h of [
    "host",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "x-forwarded-for",
    "x-real-ip",
    "x-forwarded-proto",
    "x-forwarded-host",
  ]) {
    headers.delete(h);
  }
  headers.set("Origin", targetUrl.origin);
  headers.set("Referer", targetUrl.origin + "/");
  if (realIp) {
    headers.set("X-Real-IP", realIp);
    headers.set("X-Forwarded-For", realIp);
  }

  const isStatic =
    STATIC_ASSET_RE.test(targetUrl.pathname) || EMBY_IMAGE_PATH_RE.test(targetUrl.pathname);

  const init: RequestInit & { cf?: { cacheEverything: boolean; cacheTtl: number } } = {
    method: request.method,
    headers,
    redirect: "manual",
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  };
  if (isStatic) {
    init.cf = { cacheEverything: true, cacheTtl: 86400 };
  }

  const resp = await fetch(targetUrl.toString(), init);
  const respHeaders = new Headers(resp.headers);
  const proxyOrigin = new URL(request.url).origin;
  const prefix = EMBY_BASE_PATH + "/" + prefixName;

  // 绝对 URL → Worker 路径：同源用名称形式，跨域用编码地址形式。
  // 编码形式与用户粘贴的原样形式区分，回流请求不会触发自动注册。
  const rewriteUrl = (u: URL): string => {
    if (u.origin === backendOrigin) {
      return prefix + u.pathname + u.search;
    }
    return EMBY_BASE_PATH + "/" + encodeURIComponent(u.toString());
  };

  // 302 拦截：重定向目标改写回 Worker，客户端不脱离代理
  if (REDIRECT_STATUSES.has(resp.status)) {
    const loc = respHeaders.get("Location");
    if (loc) {
      try {
        const rewritten = rewriteUrl(new URL(loc, targetUrl));
        if (rewritten) respHeaders.set("Location", rewritten);
      } catch {
        // Location 解析失败：原样透传
      }
    }
  }
  respHeaders.set("Access-Control-Allow-Origin", "*");

  // PlaybackInfo JSON 重写：播放直链改走 Worker
  if (
    resp.status === 200 &&
    (respHeaders.get("content-type") || "").includes("json") &&
    targetUrl.pathname.toLowerCase().includes("playbackinfo")
  ) {
    try {
      const data = (await resp.clone().json()) as {
        MediaSources?: Array<Record<string, unknown>>;
      };
      let modified = false;
      for (const source of data?.MediaSources ?? []) {
        for (const key of ["DirectStreamUrl", "TranscodingUrl"]) {
          const v = source[key];
          if (typeof v === "string" && v.startsWith("http")) {
            try {
              const rewritten = rewriteUrl(new URL(v));
              if (rewritten) {
                source[key] = proxyOrigin + rewritten;
                modified = true;
              }
            } catch {
              // URL 解析失败：保留原值
            }
          }
        }
      }
      if (modified) {
        respHeaders.delete("Content-Length");
        return new Response(JSON.stringify(data), {
          status: resp.status,
          statusText: resp.statusText,
          headers: respHeaders,
        });
      }
    } catch (e) {
      console.log("PlaybackInfo rewrite failed:", (e as Error).message);
    }
  }

  // M3U8 重写：切片直链改走 Worker
  if (resp.status === 200 && targetUrl.pathname.toLowerCase().endsWith(".m3u8")) {
    try {
      const text = await resp.clone().text();
      if (text.includes("http://") || text.includes("https://")) {
        const rewritten = text.replace(/(https?:\/\/[^\s]+)/g, (m) => {
          try {
            const r = rewriteUrl(new URL(m));
            return r ? proxyOrigin + r : m;
          } catch {
            return m;
          }
        });
        respHeaders.delete("Content-Length");
        return new Response(rewritten, {
          status: resp.status,
          statusText: resp.statusText,
          headers: respHeaders,
        });
      }
    } catch (e) {
      console.log("M3U8 rewrite failed:", (e as Error).message);
    }
  }

  if (isStatic) {
    respHeaders.set("Cache-Control", "public, max-age=86400");
    respHeaders.delete("Expires");
    respHeaders.delete("Pragma");
  } else {
    respHeaders.set("Cache-Control", "no-store");
  }

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: respHeaders,
  });
}

// ---------- TMDB 反向代理（Worker 直接转发，不走节点） ----------

const TMDB_API_ORIGIN = "https://api.themoviedb.org";

export async function handleTmdbRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const subpath = url.pathname.slice((EMBY_BASE_PATH + "/tmdb").length) || "/";
  const target = TMDB_API_ORIGIN + subpath + url.search;

  const headers = new Headers();
  for (const k of ["accept", "content-type", "authorization"]) {
    const v = request.headers.get(k);
    if (v) headers.set(k, v);
  }

  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
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

  // Path: /emby/<backend_url>（原样或 URL 编码，编码形式来自 302 改写）
  const prefix = EMBY_BASE_PATH + "/";
  let backendUrlFull = path.startsWith(prefix) ? path.slice(prefix.length) : "";
  const rawForm = /^https?:\/\//i.test(backendUrlFull);
  if (!rawForm) {
    try {
      backendUrlFull = decodeURIComponent(backendUrlFull);
    } catch {
      // 保留原样，下面统一报 400
    }
  }
  if (!backendUrlFull.startsWith("http://") && !backendUrlFull.startsWith("https://")) {
    return new Response("Bad Request: backend URL must start with http:// or https://", { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(backendUrlFull);
    if (isPrivateHost(parsed.hostname)) {
      return new Response("Forbidden: backend URL points to a private or reserved address", { status: 403 });
    }
  } catch {
    return new Response("Bad Request: invalid backend URL", { status: 400 });
  }
  const backendOrigin = parsed.origin;
  // URL 自带 query（编码形式常见，如 CDN 签名）与外层 query 合并
  const combinedSearch = parsed.search
    ? parsed.search + (url.search ? "&" + url.search.slice(1) : "")
    : url.search;

  const [embysKV, nodesKV] = await Promise.all([readEmbys(env), readNodes(env)]);

  let emby = embysKV.embys.find((e) => e.backend_url === backendOrigin);
  // 只在原样形式（用户粘贴入口）时自动注册；编码形式是改写回流（多为 CDN），不注册避免刷表
  if (!emby && rawForm) {
    const anyNode = nodesKV.nodes[0];

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
        node_id: anyNode?.id ?? "",
        home_node_id: anyNode?.id ?? "",
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

  // 地址访问必走本地代理。未注册的源（CDN 回流）：无名称前缀，改写全部用编码地址形式
  const target = backendOrigin + parsed.pathname + combinedSearch;
  return proxyLocal(request, target, emby?.name ?? "", emby ? emby.backend_url : "");
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

// 请求级存活探测：GET /__health，3s 超时，isolate 内存缓存。
// 非对称 TTL：活 30s（控制节点刚挂时的盲区），死 15s（更快重试发现恢复）。
// 节点失败的判定以此为准（请求驱动、秒级发现），不依赖 cron 探活周期。
const aliveCache = new Map<string, { alive: boolean; ts: number }>();
const ALIVE_TTL_OK_MS = 30_000;
const ALIVE_TTL_FAIL_MS = 15_000;

async function probeAlive(node: NodeRecord): Promise<boolean> {
  const hit = aliveCache.get(node.id);
  if (hit && Date.now() - hit.ts < (hit.alive ? ALIVE_TTL_OK_MS : ALIVE_TTL_FAIL_MS)) {
    return hit.alive;
  }

  let alive = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(
      node.public_url.replace(/\/$/, "") + NODE_HEALTH_PATH,
      { signal: controller.signal },
    );
    alive = resp.ok;
  } catch {
    alive = false;
  } finally {
    clearTimeout(timer);
  }
  aliveCache.set(node.id, { alive, ts: Date.now() });
  return alive;
}

async function chooseNode(
  env: Env,
  emby: EmbyRecord,
  nodes: NodeRecord[],
  ctx: ExecutionContext,
): Promise<NodeRecord | null> {
  if (!emby.node_id) {
    // 直连模式：不经过代理
    return null;
  }

  const primary = nodes.find((n) => n.id === emby.node_id);

  if (primary && (await probeAlive(primary))) {
    return primary;
  }

  // 当前节点探测不通：并行发起其余节点探测，按排序从当前节点位置依次往下
  // await，第一个活的立即返回（不等更慢/超时的后位节点；全灭最坏 3s 而非 3s×N）。
  // nodes 已由 readNodes 按 sort_order 排好序。
  const startIdx = nodes.findIndex((n) => n.id === emby.node_id);
  const probes = new Map<string, Promise<boolean>>();
  for (const n of nodes) {
    if (n.id !== emby.node_id) probes.set(n.id, probeAlive(n));
  }
  let pick: NodeRecord | null = null;
  for (let i = 1; i <= nodes.length; i++) {
    const candidate = nodes[(startIdx + i) % nodes.length]!;
    if (candidate.id !== emby.node_id && (await probes.get(candidate.id))) {
      pick = candidate;
      break;
    }
  }
  if (pick) {
    console.warn(
      `node '${emby.node_id}' unhealthy for emby='${emby.name}', failover to '${pick.id}' (home='${emby.home_node_id}')`,
    );
    // 持久化转移：该不健康节点关联的所有 emby 一并切到新节点，后续请求直达；
    // home_node_id 保持原始配置，探活确认原节点恢复后由 runHealthCycle 切回。
    // 写库前实时复核探测一次，防 health 表误报/过期导致整节点 emby 被误搬。
    const unhealthyId = emby.node_id;
    const pickId = pick.id;
    ctx.waitUntil(
      persistIfConfirmedDead(env, nodes, unhealthyId, pickId),
    );
    return pick;
  }

  // 全部不健康：持久化为直连（node_id=''），后续请求不再逐个探健康，
  // 直接 307 backend_url；home_node_id 不动，探活发现原节点恢复后由 failback 切回。
  // 同样先复核探测再写库。
  const unhealthyId = emby.node_id;
  console.warn(
    `all nodes unhealthy for emby='${emby.name}', fallback to direct (home='${emby.home_node_id}')`,
  );
  ctx.waitUntil(persistIfConfirmedDead(env, nodes, unhealthyId, ""));
  return null;
}

// 误报防护：持久化故障转移前，对「不健康」节点实时探测一次确认。
// 节点其实活着（health 表过期/误报）→ 跳过写库，等 cron 自愈；确认挂了才搬迁。
async function persistIfConfirmedDead(
  env: Env,
  nodes: NodeRecord[],
  unhealthyId: string,
  targetId: string,
): Promise<void> {
  try {
    const node = nodes.find((n) => n.id === unhealthyId);
    if (node) {
      const probe = await immediateProbe(node, env.EMBY_SYNC_TOKEN, 1);
      if (probe.healthy) {
        console.log(
          `[failover] probe says '${unhealthyId}' alive, skip persisting (stale health)`,
        );
        return;
      }
    }
    const r = await env.EMBY_DB.prepare(
      "UPDATE embys SET node_id = ? WHERE node_id = ?",
    )
      .bind(targetId, unhealthyId)
      .run();
    // 同步回写 health 表，让管理 UI 状态与实际切换一致（不用等 cron）
    await env.EMBY_DB.prepare(
      "UPDATE health SET healthy = 0, last_check = ?, consecutive_fails = consecutive_fails + 1 WHERE node_id = ?",
    )
      .bind(new Date().toISOString(), unhealthyId)
      .run();
    console.log(
      `[failover] confirmed dead, moved ${r.meta.changes ?? "?"} embys from '${unhealthyId}' to '${targetId || "direct"}', health marked down`,
    );
  } catch (err) {
    console.error(`[failover] persist failed: ${err}`);
  }
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
