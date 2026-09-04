import adminHtml from "../admin.html";
import { classifyIsp } from "../isp";
import type { Env } from "../types";
import { buildLoginCookie, buildLogoutCookie, checkAdminAuth, createSession, destroySession } from "./auth";
import {
  handleAddEmby,
  handleAddNode,
  handleCreateGroup,
  handleDeleteEmby,
  handleDeleteGroup,
  handleDeleteNode,
  handleGetConfig,
  handleHealth,
  handleListEmbys,
  handleListGroups,
  handleListNodes,
  handleManualSync,
  handleProbe,
  handleReorderNodes,
  handleUpdateConfig,
  handleUpdateEmby,
  handleUpdateGroup,
  handleUpdateNode,
} from "./handlers";

export async function routeAdmin(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  // 挂载点为 /emby/admin：只在 second==="admin" 精确匹配时进入本函数，
  // 直接切掉 /emby 前缀（无 lookahead，避免 /emby/administrator 之类歧义）
  const path = url.pathname.startsWith("/emby")
    ? url.pathname.slice("/emby".length)
    : url.pathname;
  const method = request.method;

  // Static UI
  if (path === "/admin" || path === "/admin/" || path === "/admin/ui") {
    return new Response(adminHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Login / logout（不要鉴权）
  if (path === "/admin/api/login" && method === "POST") {
    return handleLogin(request, env);
  }
  if (path === "/admin/api/logout" && method === "POST") {
    return handleLogout(request);
  }

  // 余下接口都要鉴权
  if (!checkAdminAuth(request, env)) {
    return jsonError(401, "unauthorized");
  }

  // /admin/api/me — 用于 UI 检测登录态
  if (path === "/admin/api/me" && method === "GET") {
    return jsonOk({ ok: true });
  }

  // Nodes CRUD
  if (path === "/admin/api/nodes") {
    if (method === "GET") return handleListNodes(env);
    if (method === "POST") return wrapJson(request, (req) => handleAddNode(req, env, ctx));
  }
  if (path === "/admin/api/nodes/reorder" && method === "POST") {
    return wrapJson(request, (req) => handleReorderNodes(req, env));
  }
  const nodeMatch = path.match(/^\/admin\/api\/nodes\/([^/]+)$/);
  if (nodeMatch) {
    const id = nodeMatch[1]!;
    if (method === "PUT")
      return wrapJson(request, (req) => handleUpdateNode(req, env, id));
    if (method === "DELETE") return handleDeleteNode(env, id);
  }

  // Embys CRUD
  if (path === "/admin/api/embys") {
    if (method === "GET") return handleListEmbys(env);
    if (method === "POST") return wrapJson(request, (req) => handleAddEmby(req, env));
  }
  const embyMatch = path.match(/^\/admin\/api\/embys\/([^/]+)$/);
  if (embyMatch) {
    const name = decodeURIComponent(embyMatch[1]!);
    if (method === "PUT")
      return wrapJson(request, (req) => handleUpdateEmby(req, env, name));
    if (method === "DELETE") return handleDeleteEmby(env, name);
  }

  // 代理组 CRUD
  if (path === "/admin/api/groups") {
    if (method === "GET") return handleListGroups(env);
    if (method === "POST") return wrapJson(request, (req) => handleCreateGroup(req, env));
  }
  const groupMatch = path.match(/^\/admin\/api\/groups\/(\d+)$/);
  if (groupMatch) {
    const groupId = Number(groupMatch[1]);
    if (method === "PUT")
      return wrapJson(request, (req) => handleUpdateGroup(req, env, groupId));
    if (method === "DELETE") return handleDeleteGroup(env, groupId);
  }

  // 入口网络诊断：显示当前请求（管理面板操作者）的 ASN 归类，用于校验判定逻辑
  if (path === "/admin/api/diag" && method === "GET") {
    const cf = (
      request as Request & { cf?: { asn?: number; asOrganization?: string } }
    ).cf;
    return jsonOk({
      asn: cf?.asn ?? null,
      as_organization: cf?.asOrganization ?? null,
      isp: classifyIsp(cf?.asn, cf?.asOrganization),
    });
  }

  // 全局代理模式
  if (path === "/admin/api/config") {
    if (method === "GET") return handleGetConfig(env);
    if (method === "PUT") return wrapJson(request, (req) => handleUpdateConfig(req, env));
  }

  // Health & manual sync & probe
  if (path === "/admin/api/health" && method === "GET") return handleHealth(env);
  if (path === "/admin/api/probe" && method === "POST") return handleProbe(env, ctx);
  if (path === "/admin/api/sync" && method === "POST") return handleManualSync(env);

  return jsonError(404, "not found");
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await safeJson(request);
  const token = body?.token;
  if (typeof token !== "string" || token !== env.ADMIN_TOKEN) {
    return jsonError(401, "token 无效");
  }
  const sessionId = createSession();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": buildLoginCookie(sessionId),
      "Cache-Control": "no-store",
    },
  });
}

function handleLogout(request: Request): Response {
  destroySession(request);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": buildLogoutCookie(),
      "Cache-Control": "no-store",
    },
  });
}

async function wrapJson(
  request: Request,
  fn: (req: { url: URL; body: any }) => Promise<Response>,
): Promise<Response> {
  const body = await safeJson(request);
  if (body === undefined) {
    return jsonError(400, "invalid json");
  }
  return fn({ url: new URL(request.url), body });
}

async function safeJson(request: Request): Promise<any | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
