import { describe, it, expect } from "vitest";
import {
  buildLoginCookie,
  checkAdminAuth,
  createSession,
  signSession,
  verifySession,
} from "./auth";
import { ADMIN_COOKIE } from "../constants";
import type { Env } from "../types";

const env = { ADMIN_TOKEN: "test-secret" } as Env;

function reqWithCookie(session: string): Request {
  return new Request("https://example.com/emby/admin/api/nodes", {
    headers: { Cookie: `${ADMIN_COOKIE}=${session}` },
  });
}

function reqWithBearer(token: string): Request {
  return new Request("https://example.com/emby/admin/api/nodes", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("管理鉴权（签名会话）", () => {
  it("Bearer 正确 token 通过 / 错误 token 拒绝", async () => {
    expect(await checkAdminAuth(reqWithBearer("test-secret"), env)).toBe(true);
    expect(await checkAdminAuth(reqWithBearer("wrong"), env)).toBe(false);
  });

  it("登录签发的会话通过校验并正确写入 Cookie", async () => {
    const session = await createSession(env);
    expect(await checkAdminAuth(reqWithCookie(session), env)).toBe(true);
    expect(buildLoginCookie(session)).toContain(`${ADMIN_COOKIE}=${session}`);
  });

  it("伪造的裸 UUID cookie 被拒绝（回归：旧实现的鉴权绕过）", async () => {
    expect(await checkAdminAuth(reqWithCookie(crypto.randomUUID()), env)).toBe(false);
  });

  it("篡改签名 / 篡改过期时间 / 换密钥均不通过", async () => {
    const uuid = crypto.randomUUID();
    const exp = Date.now() + 60_000;
    const good = await signSession("test-secret", uuid, exp);
    const sig = good.split(".")[2]!;
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    expect(await verifySession("test-secret", `${uuid}.${exp}.${flipped}`)).toBe(false);
    expect(await verifySession("test-secret", `${uuid}.${exp + 1000}.${sig}`)).toBe(false);
    expect(await verifySession("other-secret", good)).toBe(false);
  });

  it("过期会话被拒绝", async () => {
    const expired = await signSession("test-secret", crypto.randomUUID(), Date.now() - 1000);
    expect(await checkAdminAuth(reqWithCookie(expired), env)).toBe(false);
  });

  it("无 cookie / 无 Authorization → 拒绝", async () => {
    expect(
      await checkAdminAuth(new Request("https://example.com/emby/admin/api/nodes"), env),
    ).toBe(false);
  });
});
