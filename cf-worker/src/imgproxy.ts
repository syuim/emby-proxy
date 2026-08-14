// /img 与 /url 通用代理：仅 GET ?url=...（固定 GET、不可自定义头/体，避免成为开放中继）
// 无鉴权。UA 未指定时随机伪装浏览器；Referer 按外部规则表自动补齐（防盗链）。
// /url 与 /img 行为完全一致（同一实现），用于代理图片外的任意 http(s) 资源。
import { isPrivateHost } from "./router";
import { IMAGE_CACHE_MAX_AGE } from "./constants";
import type { Env } from "./types";

const UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
];

function randomUA(): string {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)]!;
}

// 外部 Referer 规则文件（默认 https://static.laoz.org/proxy/proxy_prefer.txt，
// 可用环境变量 REFERER_RULES_URL 覆盖）：每行一个完整 URL（https://sspai.com），
// 域名作 pattern、整行作 Referer。isolate 内存缓存 1 小时。
const DEFAULT_REFERER_RULES_URL = "https://static.laoz.org/proxy/proxy_prefer.txt";
const RULES_CACHE_TTL_MS = 3600 * 1000;

interface RefererRule {
  pattern: RegExp;
  referer: string;
}

const BUILTIN_RULES: RefererRule[] = [
  { pattern: /^https:\/\/(?:[a-z0-9-]+\.)*sspai\.com(?:\/|$)/, referer: "https://sspai.com" },
  { pattern: /^https:\/\/(?:[a-z0-9-]+\.)*indienova\.com(?:\/|$)/, referer: "https://indienova.com" },
  // 豆瓣图片防盗链：img*.doubanio.com 无 Referer 返回 418
  { pattern: /^https:\/\/(?:[a-z0-9-]+\.)*doubanio\.com(?:\/|$)/, referer: "https://movie.douban.com/" },
  { pattern: /^https:\/\/(?:[a-z0-9-]+\.)*douban\.com(?:\/|$)/, referer: "https://movie.douban.com/" },
];

let rulesCache: { rules: RefererRule[]; expiry: number } = { rules: [], expiry: 0 };

async function loadRefererRules(env: Env): Promise<RefererRule[]> {
  const now = Date.now();
  if (rulesCache.rules.length > 0 && now < rulesCache.expiry) {
    return rulesCache.rules;
  }
  const rulesUrl = env.REFERER_RULES_URL || DEFAULT_REFERER_RULES_URL;
  const externalRules = await (async () => {
    try {
      const resp = await fetch(rulesUrl);
      if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
      const text = await resp.text();
      return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && line.startsWith("https://"))
        .flatMap((line): RefererRule[] => {
          try {
            const hostname = new URL(line).hostname.replace(/\./g, "\\.");
            return [{ pattern: new RegExp(`^https://(?:[a-z0-9-]+\\.)*${hostname}(?:/|$)`), referer: line }];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  })();
  // 内置规则始终生效（豆瓣防盗链），外部文件作增量，同 host 去重
  const merged = [...BUILTIN_RULES];
  for (const rule of externalRules) {
    if (!merged.some((b) => b.pattern.source === rule.pattern.source)) {
      merged.push(rule);
    }
  }
  rulesCache = { rules: merged.length > 0 ? merged : BUILTIN_RULES, expiry: now + RULES_CACHE_TTL_MS };
  return rulesCache.rules;
}

async function getReferer(url: string, env: Env): Promise<string> {
  const rules = await loadRefererRules(env);
  for (const rule of rules) {
    if (rule.pattern.test(url)) return rule.referer;
  }
  return "";
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

function error(msg: string, status = 400): Response {
  return new Response(msg, { status, headers: CORS_HEADERS });
}

export async function handleUrlRequest(request: Request, env: Env): Promise<Response> {
  // /url 与 /img 同一实现，行为完全一致
  return handleImgRequest(request, env);
}

export async function handleImgRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const reqUrl = new URL(request.url);
  const searchParams = reqUrl.searchParams;
  const origin = request.headers.get("origin") || "*";

  let targetURL = "";
  let targetMethod = "GET";
  let targetBody: string | null = null;
  let targetHeaders: Record<string, string> = {};

  if (request.method === "GET") {
    targetURL = searchParams.get("url") || "";
    if (searchParams.has("method")) targetMethod = searchParams.get("method")!.toUpperCase();
    if (searchParams.has("body")) targetBody = searchParams.get("body");
    if (searchParams.has("headers")) {
      try {
        targetHeaders = JSON.parse(searchParams.get("headers")!);
      } catch {
        return error("headers not valid");
      }
    }
  } else if (request.method === "POST") {
    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return error("body not valid json");
    }
    if (payload.url) targetURL = payload.url;
    if (payload.method) targetMethod = String(payload.method).toUpperCase();
    if (payload.body) {
      targetBody = typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body);
    }
    if (payload.headers) targetHeaders = payload.headers;
  } else {
    return error("Method not implemented");
  }

  if (!targetURL) return error("URL not found");
  if (!/^https?:\/\//.test(targetURL)) return error("URL not valid");
  if (!ALLOWED_METHODS.has(targetMethod)) return error("Target method not allowed");
  if (targetMethod === "GET" && targetBody) return error("GET method can't have body");
  if (Object.prototype.toString.call(targetHeaders) !== "[object Object]") {
    return error("Headers not valid");
  }

  let targetParsed: URL;
  try {
    targetParsed = new URL(targetURL);
  } catch {
    return error("URL not valid");
  }
  if (targetParsed.hostname === reqUrl.hostname) {
    return error("Self proxy is not allowed");
  }
  if (isPrivateHost(targetParsed.hostname)) {
    return error("Forbidden: target points to a private or reserved address", 403);
  }

  if (!targetHeaders["User-Agent"]) targetHeaders["User-Agent"] = randomUA();
  const referer = await getReferer(targetURL, env);
  if (referer && !targetHeaders["Referer"]) {
    targetHeaders["Referer"] = referer;
  }

  // 仅幂等 GET（且无自定义 body）可缓存：cacheEverything 让 CF 边缘缓存出网子请求，
  // 命中即省回源；cacheTtlByStatus 只缓存 2xx，避免把 404/错误页缓存住。
  const cacheable = targetMethod === "GET" && !targetBody;
  const init: RequestInit & {
    cf?: { cacheEverything: boolean; cacheTtlByStatus: Record<string, number> };
  } = {
    method: targetMethod,
    body: targetBody || undefined,
    headers: targetHeaders,
  };
  if (cacheable) {
    init.cf = {
      cacheEverything: true,
      cacheTtlByStatus: { "200-299": IMAGE_CACHE_MAX_AGE, "300-599": 0 },
    };
  }

  let response: Response;
  try {
    response = await fetch(targetURL, init);
  } catch {
    return error("Bad Gateway: fetch failed", 502);
  }

  const cacheHit = cacheable && response.status >= 200 && response.status < 300;
  const respHeaders: Record<string, string> = {
    ...CORS_HEADERS,
    "Access-Control-Allow-Origin": origin,
    "Content-Type": response.headers.get("Content-Type") || "application/octet-stream",
    "Cache-Control": cacheHit ? `public, max-age=${IMAGE_CACHE_MAX_AGE}` : "no-store",
  };
  // 响应回显请求 Origin，公共缓存需按 Origin 分桶，避免跨源命中导致 CORS 报错
  if (cacheHit) respHeaders["Vary"] = "Origin";

  return new Response(response.body, {
    status: response.status,
    headers: respHeaders,
  });
}
