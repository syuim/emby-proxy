import { ADMIN_COOKIE, ADMIN_COOKIE_MAX_AGE } from "../constants";
import type { Env } from "../types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 接受两种鉴权方式：
 * 1) Cookie: admin_token=<SESSION_ID>（UI 登录后下发，避免明文 ADMIN_TOKEN）
 * 2) Authorization: Bearer <ADMIN_TOKEN>（脚本 / curl 调用）
 *
 * session 无需服务端存储：cookie 本身即凭证，UUID 不可猜测。
 */
export function checkAdminAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length) === env.ADMIN_TOKEN;
  }
  const sessionId = getCookie(request, ADMIN_COOKIE);
  return sessionId !== null && UUID_RE.test(sessionId);
}

export function createSession(): string {
  return crypto.randomUUID();
}

export function destroySession(_request: Request): void {
  // session 在客户端，服务端无需操作
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
