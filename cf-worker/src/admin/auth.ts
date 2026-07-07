import { ADMIN_COOKIE, ADMIN_COOKIE_MAX_AGE } from "../constants";
import type { Env } from "../types";

// ponytail: volatile session store — lost on redeploy but fine for admin UI.
// Upgrade to KV-backed sessions if persistence across deploys matters.
const sessions = new Set<string>();

/**
 * 接受两种鉴权方式：
 * 1) Cookie: admin_token=<SESSION_ID>（UI 登录后下发，避免明文 ADMIN_TOKEN）
 * 2) Authorization: Bearer <ADMIN_TOKEN>（脚本 / curl 调用）
 */
export function checkAdminAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length) === env.ADMIN_TOKEN;
  }
  const sessionId = getCookie(request, ADMIN_COOKIE);
  return sessionId !== null && sessions.has(sessionId);
}

export function createSession(): string {
  const sessionId = crypto.randomUUID();
  sessions.add(sessionId);
  return sessionId;
}

export function destroySession(request: Request): void {
  const sessionId = getCookie(request, ADMIN_COOKIE);
  if (sessionId) sessions.delete(sessionId);
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