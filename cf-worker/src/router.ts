import { EMBY_BASE_PATH, RESERVED_NAMES, DOUBAN_API_BASE_PATH, DOUBAN_API_EMBY_NAME, TMDB_BASE_PATH, URL_BASE_PATH } from "./constants";
import { handleUrlRequest } from "./urlproxy";
import { readConfigMeta, readEmbys, readGroups, readNodes } from "./storage";
import { chooseNodeFromGroup, classifyClientIsp } from "./group";
import type { Env } from "./types";



export async function handleClientRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const segments = path.split("/").filter(Boolean); // ["emby", <name>, ...subpath]
  const embyName = segments[1];
  if (!embyName) {
    return notFound("missing emby name");
  }
  if (RESERVED_NAMES.has(embyName.toLowerCase())) {
    return notFound("reserved path");
  }
  return routeNameAccess(request, env, embyName, "/" + segments.slice(2).join("/"));
}

// 名称访问统一分发：/emby/<name>/<subpath> 与 /doubanapi 别名（固定 emby 记录名）共用。
// 规则：direct → 307 直连；local → Worker 本地代理；node → 绑组走组路由（overseas
// 入口先 307 直连，国内按入口 ASN 过滤组内节点后随机 307），未绑组/全灭 → Worker local。
async function routeNameAccess(
  request: Request,
  env: Env,
  embyName: string,
  subpath: string,
): Promise<Response> {
  const url = new URL(request.url);
  const [embysKV, nodesKV, configMeta] = await Promise.all([
    readEmbys(env),
    readNodes(env),
    readConfigMeta(env),
  ]);

  const emby = embysKV.embys.find((e) => e.name === embyName);
  if (!emby) {
    return notFound(`unknown emby '${embyName}'`);
  }

  const clientIp = request.headers.get("CF-Connecting-IP") ?? "-";
  const isp = classifyClientIsp(request);

  // 规则：全局模式决定路由
  const target = buildTargetUrl(emby.backend_url, subpath, url.search);
  switch (configMeta.proxy_mode) {
    case "direct":
      console.log(`[req] ip=${clientIp} isp=${isp} emby=${emby.name} mode=direct`);
      return new Response(null, {
        status: 307,
        headers: { Location: target, "Cache-Control": "no-store" },
      });
    case "local":
      console.log(`[req] ip=${clientIp} isp=${isp} emby=${emby.name} mode=local`);
      return proxyLocal(request, target, emby.name, emby.backend_url);
  }

  // case 'node': emby 绑定代理组 → 组内按入口网络过滤后纯随机；未绑组走下方 Worker local
  if (emby.group_id != null) {
    // 海外/未知 ASN（未命中国内运营商）→ 307 直连 emby 后端，不经节点（等同全局 direct 语义）
    if (isp === "overseas") {
      console.log(`[req] ip=${clientIp} isp=${isp} emby=${emby.name} mode=direct reason=isp-overseas`);
      return new Response(null, {
        status: 307,
        headers: { Location: target, "Cache-Control": "no-store" },
      });
    }
    const pick = await chooseNodeFromGroup(env, emby.group_id, nodesKV.nodes, isp);
    if (pick) {
      const groups = await readGroups(env);
      const groupName = groups.find((g) => g.id === emby.group_id)?.name ?? String(emby.group_id);
      console.log(
        `[req] ip=${clientIp} isp=${isp} emby=${emby.name} mode=group group=${groupName} stage=${pick.stage} alive=${pick.aliveNames.join(",")} pool=${pick.poolNames.join(",")} node=${pick.node.name}`,
      );
      // 节点协议路径不含 /emby 前缀：/<name>/subpath
      const nodeTarget = buildTargetUrl(pick.node.public_url, "/" + emby.name + subpath, url.search);
      return new Response(null, {
        status: 307,
        headers: {
          Location: nodeTarget,
          "Cache-Control": "no-store",
        },
      });
    }
    // 组不存在/无成员/全灭 → Worker local 兜底
    console.log(
      `[req] ip=${clientIp} isp=${isp} emby=${emby.name} mode=group-fallback reason=no-usable-node`,
    );
    return proxyLocal(request, target, emby.name, emby.backend_url);
  }

  // node 模式 + 未绑组：节点只通过代理组使用，未绑组直接 Worker local
  console.log(`[req] ip=${clientIp} isp=${isp} emby=${emby.name} mode=local reason=no-group`);
  return proxyLocal(request, target, emby.name, emby.backend_url);
}

// ---------- Worker 本地代理引擎 ----------
// 全程 Worker 中转：客户端只看到 Worker 域名。隐藏客户端真实 IP：不注入
// X-Real-IP / X-Forwarded-For，后端只见 CF 边缘出口 IP。
// 改写规则：同源（emby 后端自身）→ 名称形式 /emby/<name>/path；
// 跨域（CDN 直链）→ 编码地址形式 /emby/<encodeURIComponent(url)>。

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// 图片/字幕类可长缓存；前端资源（js/css 等）随版本更新，短缓存避免客户端拿到过期代码
const STATIC_ASSET_RE =
  /\.(jpg|jpeg|gif|png|svg|ico|webp|srt|ass|vtt|sub)$/i;
const FRONTEND_ASSET_RE =
  /\.(js|css|woff2?|ttf|otf|map|webmanifest)$/i;
const EMBY_IMAGE_PATH_RE = /(\/Images\/|\/Icons\/|\/Branding\/|\/emby\/covers\/)/i;
const FRONTEND_ASSET_MAX_AGE = 60 * 60; // 1h

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

  // 隐藏客户端真实 IP：抹 CF/代理头 + 对齐 Origin/Referer，不注入 IP 头
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

  const isStatic =
    STATIC_ASSET_RE.test(targetUrl.pathname) || EMBY_IMAGE_PATH_RE.test(targetUrl.pathname);
  const isFrontend =
    FRONTEND_ASSET_RE.test(targetUrl.pathname);

  const init: RequestInit & { cf?: { cacheEverything: boolean; cacheTtl: number } } = {
    method: request.method,
    headers,
    redirect: "manual",
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  };
  if (isStatic) {
    init.cf = { cacheEverything: true, cacheTtl: 86400 };
  } else if (isFrontend) {
    init.cf = { cacheEverything: true, cacheTtl: FRONTEND_ASSET_MAX_AGE };
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
        const rewritten = rewriteM3u8Urls(text, (m) => {
          const r = rewriteUrl(new URL(m));
          return r ? proxyOrigin + r : m;
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
  } else if (isFrontend) {
    respHeaders.set("Cache-Control", `public, max-age=${FRONTEND_ASSET_MAX_AGE}`);
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
// 一级命名空间 /tmdb/...（原 /emby/tmdb/...，路由已提前到最前面）

const TMDB_API_ORIGIN = "https://api.themoviedb.org";
// TMDB 图片域名：图片路径统一以 /t/p/<size>/<file> 开头（image.tmdb.org 固定结构）
const TMDB_IMAGE_ORIGIN = "https://image.tmdb.org";

// 识别 TMDB 图片路径：/t/p/... → 走 image.tmdb.org + /url 通用代理
// （/url 提供 UA 伪装、Referer 规则与图片边缘缓存，见 urlproxy.ts）
export function isTmdbImageSubpath(subpath: string): boolean {
  return /^\/t\/p\//.test(subpath);
}

export async function handleTmdbRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const subpath = url.pathname.slice(TMDB_BASE_PATH.length) || "/";

  // 图片路径：转发到 TMDB 图片域名，并复用 /url 通用代理（UA 伪装 + Referer + 图片缓存）
  if (request.method === "GET" && isTmdbImageSubpath(subpath)) {
    const imgUrl = TMDB_IMAGE_ORIGIN + subpath + url.search;
    const imgReq = new Request(`https://proxy.laoz.org${URL_BASE_PATH}?url=${encodeURIComponent(imgUrl)}`, {
      method: "GET",
      headers: request.headers,
    });
    return handleUrlRequest(imgReq, env, ctx);
  }

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

// ---------- Douban API 别名入口 ----------
// /doubanapi/... 按 emby 记录名（DOUBAN_API_EMBY_NAME）走 routeNameAccess 统一链路
// （ASN 分类 → 组路由 → 节点/local/直连），让豆瓣 API 后端也能按运营商经节点分发；
// 原请求对象原样传递（保留 cf 等属性），客户端访问路径保持不变。

export function doubanApiSubpath(pathname: string): string {
  return pathname.slice(DOUBAN_API_BASE_PATH.length) || "/";
}

export async function handleDoubanApiRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    // 预检由 Worker 直接应答，避免被 307 到节点/后端（浏览器 addon 依赖）
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

  return routeNameAccess(
    request,
    env,
    DOUBAN_API_EMBY_NAME,
    doubanApiSubpath(new URL(request.url).pathname),
  );
}

// ---------- Direct proxy (auto-register) ----------

export async function handleDirectRequest(
  request: Request,
  env: Env,
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

  const embysKV = await readEmbys(env);

  let emby = embysKV.embys.find((e) => e.backend_url === backendOrigin);
  // 只在原样形式（用户粘贴入口）时自动注册；编码形式是改写回流（多为 CDN），不注册避免刷表
  if (!emby && rawForm) {
    // 撞名极低概率，重试几次生成不同名字，避免直接 500。
    // 定向 INSERT ON CONFLICT DO NOTHING：并发首访同一后端不会重复写，也不 bump version
    for (let attempt = 0; attempt < 3; attempt++) {
      const name = await generateDirectEmbyName(backendOrigin, attempt);
      const createdAt = new Date().toISOString();
      const res = await env.EMBY_DB.prepare(
        "INSERT INTO embys(name, backend_url, created_at) VALUES(?,?,?) ON CONFLICT(name) DO NOTHING",
      ).bind(name, backendOrigin, createdAt).run();
      if (res.meta.changes > 0) {
        emby = {
          name,
          backend_url: backendOrigin,
          group_id: null,
          created_at: createdAt,
        };
        break;
      }
    }
    // 3 次都撞名（理论不可能）→ 仍按未注册处理，改写走编码地址形式
  }

  // 地址访问必走本地代理。未注册的源（CDN 回流）：无名称前缀，改写全部用编码地址形式
  const target = backendOrigin + parsed.pathname + combinedSearch;
  return proxyLocal(request, target, emby?.name ?? "", emby ? emby.backend_url : "");
}

async function generateDirectEmbyName(backendUrl: string, attempt = 0): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(backendUrl));
  const hex = Array.from(new Uint8Array(hash, 0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // 撞名时加后缀重试（d_<hash> 或 d_<hash>-1/-2），仍在 32 字符上限内
  return attempt === 0 ? "d_" + hex : `d_${hex}-${attempt}`;
}

// ponytail: simple IP check for SSRF at cf-worker level. Hostname-based SSRF is caught by proxy-go's isDangerousRedirect.
export function isPrivateHost(host: string): boolean {
  // Strip IPv6 brackets
  const ip = host.startsWith("[") ? host.slice(1, -1) : host;

  // 本机与云 metadata 域名（DNS 解析结果 Worker 侧不可控，直接按域名拦截）
  if (ip === "localhost" || ip.endsWith(".localhost")) return true;
  if (ip === "metadata.google.internal" || ip.endsWith(".metadata.google.internal")) return true;

  // IPv4-mapped IPv6（::ffff:a.b.c.d 或 ::ffff:xxxx:xxxx）解映射后按 IPv4 复查
  let mappedIpv4: string | null = null;
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted) {
    mappedIpv4 = dotted[1];
  } else {
    const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      mappedIpv4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    }
  }
  if (mappedIpv4) return isPrivateHost(mappedIpv4);

  // IPv6 字面量：只按前缀判定，不做字符串前缀匹配（避免误杀 fc*/fd* 域名）
  if (ip.includes(":")) {
    if (ip === "::" || ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
    const first = ip.split(":")[0];
    if (first !== "") {
      const v = parseInt(first, 16);
      if (!isNaN(v)) {
        if ((v & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
        if ((v & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
      }
    }
    return false;
  }

  // IPv4 字面量
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 unspecified
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 169 && b === 254) return true; // link-local（含云 metadata 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24（含 Oracle metadata 192.0.0.192）
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  }
  return false;
}

// M3U8 文本改写：把每个绝对 URL 交给 rewrite。排除引号/逗号，避免
// #EXT-X-KEY / #EXT-X-MAP 行里 URL 后的 " ,IV=... 被吞进链接。
export function rewriteM3u8Urls(text: string, rewrite: (raw: string) => string): string {
  return text.replace(/(https?:\/\/[^\s"',]+)/g, (m) => {
    try {
      return rewrite(m);
    } catch {
      return m;
    }
  });
}

// 请求级存活探测已移至 alive.ts（probeAlive + 非对称 TTL 缓存），组路由共用。

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
