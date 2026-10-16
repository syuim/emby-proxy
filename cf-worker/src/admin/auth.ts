import { ADMIN_COOKIE, ADMIN_COOKIE_MAX_AGE } from "../constants";
import type { Env } from "../types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 接受两种鉴权方式：
 * 1) Cookie: admin_token=<SESSION>（UI 登录后下发）。SESSION 为
 *    `uuid.expiryMs.hmacHex`，HMAC-SHA256 密钥为 ADMIN_TOKEN——服务端零存储，
 *    签名保证凭证只能由登录流程签发，伪造任意 UUID 无效。
 * 2) Authorization: Bearer <ADMIN_TOKEN>（脚本 / curl 调用）
 */
export async function checkAdminAuth(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    return timingSafeEqual(auth.slice("Bearer ".length), env.ADMIN_TOKEN);
  }
  const sessionId = getCookie(request, ADMIN_COOKIE);
  return sessionId !== null && (await verifySession(env.ADMIN_TOKEN, sessionId));
}

export async function createSession(env: Env): Promise<string> {
  return signSession(
    env.ADMIN_TOKEN,
    crypto.randomUUID(),
    Date.now() + ADMIN_COOKIE_MAX_AGE * 1000,
  );
}

export async function signSession(
  secret: string,
  uuid: string,
  expiryMs: number,
): Promise<string> {
  const sig = await hmacHex(secret, `${uuid}.${expiryMs}`);
  return `${uuid}.${expiryMs}.${sig}`;
}

export async function verifySession(secret: string, session: string): Promise<boolean> {
  const parts = session.split(".");
  if (parts.length !== 3) return false;
  const [uuid, expiryRaw, sig] = parts as [string, string, string];
  if (!UUID_RE.test(uuid)) return false;
  const expiry = Number(expiryRaw);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  return timingSafeEqual(sig, await hmacHex(secret, `${uuid}.${expiry}`));
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
