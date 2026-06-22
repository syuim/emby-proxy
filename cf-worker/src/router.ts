import { RESERVED_NAMES } from "./constants";
import { readEmbys, readHealth, readNodes } from "./storage";
import type { EmbyRecord, Env, NodeRecord } from "./types";

export async function handleClientRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return notFound("missing emby name");
  }
  const embyName = segments[0]!;
  if (RESERVED_NAMES.has(embyName.toLowerCase())) {
    return notFound("reserved path");
  }

  const [embysKV, nodesKV] = await Promise.all([
    readEmbys(env),
    readNodes(env),
  ]);

  const emby = embysKV.embys.find((e) => e.name === embyName);
  if (!emby) {
    return notFound(`unknown emby '${embyName}'`);
  }

  const node = await chooseNode(env, emby, nodesKV.nodes);
  if (!node) {
    return new Response("Bad Gateway: emby has no resolvable node", {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const target = buildTargetUrl(node.public_url, path, url.search);
  return new Response(null, {
    status: 307,
    headers: {
      Location: target,
      "Cache-Control": "no-store",
    },
  });
}

async function chooseNode(
  env: Env,
  emby: EmbyRecord,
  nodes: NodeRecord[],
): Promise<NodeRecord | null> {
  const health = await readHealth(env);
  const primary = nodes.find((n) => n.id === emby.node_id);

  if (primary && health.nodes[primary.id]?.healthy) {
    return primary;
  }

  // 主节点不健康：从其他节点中随机挑一个健康的
  const fallbacks = nodes
    .filter((n) => n.id !== emby.node_id && health.nodes[n.id]?.healthy);
  if (fallbacks.length > 0) {
    const pick = fallbacks[Math.floor(Math.random() * fallbacks.length)]!;
    console.warn(
      `node '${emby.node_id}' unhealthy for emby='${emby.name}', picking fallback='${pick.id}'`,
    );
    return pick;
  }

  // 全部不健康：兜底原始节点，让客户端感知失败比直接 502 强
  if (primary) {
    console.warn(
      `all nodes unhealthy for emby='${emby.name}', falling back to assigned='${primary.id}'`,
    );
    return primary;
  }
  return null;
}

function buildTargetUrl(publicUrl: string, path: string, search: string): string {
  const base = publicUrl.replace(/\/$/, "");
  return `${base}${path}${search}`;
}

function notFound(reason: string): Response {
  return new Response(`Not Found: ${reason}`, {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}
