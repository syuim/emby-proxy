// /img 通用图片/请求代理：GET ?url=... 或 POST {url, method, body, headers}
// 无鉴权。UA 未指定时随机伪装浏览器；Referer 按外部规则表自动补齐（防盗链）。
import { isPrivateHost } from "./router";
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

// 外部 Referer 规则文件：每行一个完整 URL（https://sspai.com），
// 域名作 pattern、整行作 Referer。isolate 内存缓存 1 小时。
const DEFAULT_REFERER_RULES_URL = "https://static.laoz.org/bot/proxy_prefer.txt";
const RULES_CACHE_TTL_MS = 3600 * 1000;

interface RefererRule {
  pattern: RegExp;
  referer: string;
}

const BUILTIN_RULES: RefererRule[] = [
  { pattern: /sspai\.com/, referer: "https://sspai.com" },
  { pattern: /indienova\.com/, referer: "https://indienova.com" },
];

let rulesCache: { rules: RefererRule[]; expiry: number } = { rules: [], expiry: 0 };

async function loadRefererRules(env: Env): Promise<RefererRule[]> {
  const now = Date.now();
  if (rulesCache.rules.length > 0 && now < rulesCache.expiry) {
    return rulesCache.rules;
  }
  const rulesUrl = env.REFERER_RULES_URL || DEFAULT_REFERER_RULES_URL;
  try {
    const resp = await fetch(rulesUrl);
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    const text = await resp.text();
    const rules = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && line.startsWith("https://"))
      .flatMap((line): RefererRule[] => {
        try {
          const hostname = new URL(line).hostname.replace(/\./g, "\\.");
          return [{ pattern: new RegExp(hostname), referer: line }];
        } catch {
          return [];
        }
      });
    rulesCache = { rules: rules.length > 0 ? rules : BUILTIN_RULES, expiry: now + RULES_CACHE_TTL_MS };
  } catch {
    rulesCache = { rules: BUILTIN_RULES, expiry: now + RULES_CACHE_TTL_MS };
  }
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

  let response: Response;
  try {
    response = await fetch(targetURL, {
      method: targetMethod,
      body: targetBody || undefined,
      headers: targetHeaders,
    });
  } catch {
    return error("Bad Gateway: fetch failed", 502);
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Allow-Origin": origin,
      "Content-Type": response.headers.get("Content-Type") || "application/octet-stream",
    },
  });
}
