import { ADMIN_COOKIE, ADMIN_COOKIE_MAX_AGE } from "../constants";
import type { Env } from "../types";

const SESSION_PREFIX = "session:";

/**
 * 接受两种鉴权方式：
 * 1) Cookie: admin_token=<SESSION_ID>（UI 登录后下发，避免明文 ADMIN_TOKEN）
 * 2) Authorization: Bearer <ADMIN_TOKEN>（脚本 / curl 调用）
 */
export async function checkAdminAuth(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length) === env.ADMIN_TOKEN;
  }
  const sessionId = getCookie(request, ADMIN_COOKIE);
  if (!sessionId) return false;
  const stored = await env.EMBY_KV.get(SESSION_PREFIX + sessionId);
  return stored !== null;
}

export async function createSession(env: Env): Promise<string> {
  const sessionId = crypto.randomUUID();
  await env.EMBY_KV.put(SESSION_PREFIX + sessionId, "1", {
    expirationTtl: ADMIN_COOKIE_MAX_AGE,
  });
  return sessionId;
}

export async function destroySession(request: Request, env: Env): Promise<void> {
  const sessionId = getCookie(request, ADMIN_COOKIE);
  if (sessionId) await env.EMBY_KV.delete(SESSION_PREFIX + sessionId);
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || null;
  }
  return null;
}

export function buildLoginCookie(sessionId: string): string {
  return [
    `${ADMIN_COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${ADMIN_COOKIE_MAX_AGE}`,
  ].join("; ");
}

export function buildLogoutCookie(): string {
  return [
    `${ADMIN_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Max-Age=0",
  ].join("; ");
}
