import { ADMIN_COOKIE, ADMIN_COOKIE_MAX_AGE } from "../constants";
import type { Env } from "../types";

/**
 * 接受两种鉴权方式：
 * 1) Cookie: admin_token=<ADMIN_TOKEN> （UI 登录后由 Worker 下发）
 * 2) Authorization: Bearer <ADMIN_TOKEN> （脚本 / curl 调用）
 */
export function checkAdminAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length) === env.ADMIN_TOKEN;
  }
  const cookie = request.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === ADMIN_COOKIE) {
      return rest.join("=") === env.ADMIN_TOKEN;
    }
  }
  return false;
}

export function buildLoginCookie(token: string): string {
  return [
    `${ADMIN_COOKIE}=${token}`,
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
