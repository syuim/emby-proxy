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
  const candidates = [emby.primary_node_id, ...emby.backup_node_ids];
  const health = await readHealth(env);

  for (const id of candidates) {
    const node = nodes.find((n) => n.id === id);
    if (!node) continue;
    if (health.nodes[id]?.healthy) {
      return node;
    }
  }

  // 全部不健康：兜底 primary，让客户端感知失败比直接 502 强
  const primary = nodes.find((n) => n.id === emby.primary_node_id);
  if (primary) {
    console.warn(
      `all nodes unhealthy for emby='${emby.name}', falling back to primary='${primary.id}'`,
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
