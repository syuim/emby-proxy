import { routeAdmin } from "./admin";
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
      return Response.redirect(new URL("/admin", url).toString(), 302);
    }

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return routeAdmin(request, env, ctx);
    }

    if (url.pathname === "/tmdb" || url.pathname.startsWith("/tmdb/")) {
      return handleTmdbRequest(request);
    }

    // Direct proxy: /<DIRECT_PROXY_TOKEN>/<backend_url>
    if (env.DIRECT_PROXY_TOKEN) {
      const first = url.pathname.split("/").filter(Boolean)[0];
      if (first === env.DIRECT_PROXY_TOKEN) {
        return handleDirectRequest(request, env, ctx);
      }
    }

    return handleClientRequest(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await runHealthCycle(env, ctx);
  },
} satisfies ExportedHandler<Env>;
