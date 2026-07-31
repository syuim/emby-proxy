import { routeAdmin } from "./admin";
import { EMBY_BASE_PATH } from "./constants";
import { runHealthCycle } from "./health";
import { handleClientRequest, handleDirectRequest, handleTmdbRequest } from "./router";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__health") {
      return new Response("ok", {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/") {
      return Response.redirect(new URL(EMBY_BASE_PATH + "/admin", url).toString(), 302);
    }

    // 一级命名空间 /emby：admin、tmdb、token 地址访问、名称访问
    if (url.pathname.startsWith(EMBY_BASE_PATH + "/")) {
      const second = url.pathname.slice(EMBY_BASE_PATH.length + 1).split("/")[0];

      if (second === "admin") {
        return routeAdmin(request, env, ctx);
      }
      if (second === "tmdb") {
        return handleTmdbRequest(request);
      }
      if (env.DIRECT_PROXY_TOKEN && second === env.DIRECT_PROXY_TOKEN) {
        return handleDirectRequest(request, env, ctx);
      }
      return handleClientRequest(request, env, ctx);
    }

    return new Response("Not Found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await runHealthCycle(env, ctx);
  },
} satisfies ExportedHandler<Env>;
