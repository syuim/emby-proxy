import { routeAdmin } from "./admin";
import { EMBY_BASE_PATH, IMG_BASE_PATH, DOUBAN_BASE_PATH } from "./constants";
import { runHealthCycle } from "./health";
import { handleImgRequest } from "./imgproxy";
import { handleClientRequest, handleDirectRequest, handleDoubanRequest, handleTmdbRequest } from "./router";
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

    // 一级命名空间 /emby：admin、tmdb、地址访问、名称访问
    if (url.pathname.startsWith(EMBY_BASE_PATH + "/")) {
      const rest = url.pathname.slice(EMBY_BASE_PATH.length + 1);
      const second = rest.split("/")[0];

      if (second === "admin") {
        return routeAdmin(request, env, ctx);
      }
      if (second === "tmdb") {
        return handleTmdbRequest(request);
      }
      // 地址访问 /emby/http(s)://...（原样或 URL 编码）→ 必走本地代理
      if (/^https?(:\/\/|%3A)/i.test(rest)) {
        return handleDirectRequest(request, env);
      }
      return handleClientRequest(request, env, ctx);
    }

    // 一级命名空间 /img：通用图片代理
    if (url.pathname === IMG_BASE_PATH || url.pathname.startsWith(IMG_BASE_PATH + "/")) {
      return handleImgRequest(request, env);
    }

    // 一级命名空间 /douban：豆瓣 addon 反代
    if (url.pathname === DOUBAN_BASE_PATH || url.pathname.startsWith(DOUBAN_BASE_PATH + "/")) {
      return handleDoubanRequest(request);
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
