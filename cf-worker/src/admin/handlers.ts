import { EMBY_NAME_RE, RESERVED_NAMES } from "../constants";
import {
  readEmbys,
  readHealth,
  readNodes,
  writeEmbys,
  writeNodes,
} from "../storage";
import { buildSnapshot, pushSnapshotToAll } from "../sync";
import { mergeSyncResults } from "../health";
import type {
  EmbyRecord,
  EmbysKV,
  Env,
  NodeRecord,
  NodesKV,
  PushResult,
} from "../types";

interface JsonRequest {
  url: URL;
  body: any;
}

export async function handleListNodes(env: Env): Promise<Response> {
  const [nodes, health] = await Promise.all([readNodes(env), readHealth(env)]);
  return json(200, { ...nodes, health: health.nodes });
}

export async function handleAddNode(req: JsonRequest, env: Env): Promise<Response> {
  const { name, public_url } = req.body ?? {};
  if (typeof name !== "string" || typeof public_url !== "string") {
    return json(400, { error: "name 与 public_url 必填" });
  }
  const trimmed = { name: name.trim(), public_url: public_url.trim() };
  const validation = validateNode(trimmed);
  if (validation) return json(400, { error: validation });

  const nodes = await readNodes(env);
  if (nodes.nodes.some((n) => n.name === trimmed.name)) {
    return json(400, { error: `节点名 '${trimmed.name}' 已存在` });
  }
  if (nodes.nodes.some((n) => n.public_url === trimmed.public_url)) {
    return json(400, { error: `URL '${trimmed.public_url}' 已被占用` });
  }
  const newNode: NodeRecord = {
    id: generateNodeId(nodes),
    name: trimmed.name,
    public_url: trimmed.public_url.replace(/\/$/, ""),
    created_at: new Date().toISOString(),
  };
  nodes.nodes.push(newNode);
  await writeNodes(env, nodes);
  return json(201, { ok: true, node: newNode });
}

export async function handleUpdateNode(
  req: JsonRequest,
  env: Env,
  id: string,
): Promise<Response> {
  const nodes = await readNodes(env);
  const node = nodes.nodes.find((n) => n.id === id);
  if (!node) return json(404, { error: "节点不存在" });

  let changed = false;
  const { name, public_url } = req.body ?? {};
  if (typeof name === "string" && name.trim()) {
    const v = name.trim();
    if (nodes.nodes.some((n) => n.id !== id && n.name === v)) {
      return json(400, { error: `节点名 '${v}' 已被占用` });
    }
    if (v !== node.name) {
      node.name = v;
      changed = true;
    }
  }
  if (typeof public_url === "string" && public_url.trim()) {
    const v = public_url.trim().replace(/\/$/, "");
    const err = validatePublicUrl(v);
    if (err) return json(400, { error: err });
    if (nodes.nodes.some((n) => n.id !== id && n.public_url === v)) {
      return json(400, { error: `URL '${v}' 已被占用` });
    }
    if (v !== node.public_url) {
      node.public_url = v;
      changed = true;
    }
  }
  if (!changed) return json(200, { ok: true, node, skipped: true });
  await writeNodes(env, nodes);
  return json(200, { ok: true, node });
}

export async function handleDeleteNode(env: Env, id: string): Promise<Response> {
  const [nodes, embys] = await Promise.all([readNodes(env), readEmbys(env)]);
  const refs = embys.embys.filter((e) => e.node_id === id);
  if (refs.length > 0) {
    return json(400, {
      error: `节点被以下 emby 引用，请先解绑：${refs.map((r) => r.name).join(", ")}`,
    });
  }
  const before = nodes.nodes.length;
  nodes.nodes = nodes.nodes.filter((n) => n.id !== id);
  if (nodes.nodes.length === before) {
    return json(404, { error: "节点不存在" });
  }
  await writeNodes(env, nodes);
  return json(200, { ok: true });
}

export async function handleListEmbys(env: Env): Promise<Response> {
  const embys = await readEmbys(env);
  return json(200, embys);
}

export async function handleAddEmby(req: JsonRequest, env: Env): Promise<Response> {
  const { name, backend_url, node_id } = req.body ?? {};
  const trimmed: Omit<EmbyRecord, "created_at"> = {
    name: typeof name === "string" ? name.trim() : "",
    backend_url:
      typeof backend_url === "string" ? backend_url.trim().replace(/\/$/, "") : "",
    node_id: typeof node_id === "string" ? node_id : "",
  };
  const err = validateEmby(trimmed);
  if (err) return json(400, { error: err });

  const [nodes, embys] = await Promise.all([readNodes(env), readEmbys(env)]);
  const refErr = checkNodeRefs(trimmed, nodes);
  if (refErr) return json(400, { error: refErr });

  if (embys.embys.some((e) => e.name === trimmed.name)) {
    return json(400, { error: `emby '${trimmed.name}' 已存在` });
  }
  const record: EmbyRecord = { ...trimmed, created_at: new Date().toISOString() };
  embys.version += 1;
  embys.embys.push(record);
  await writeEmbys(env, embys);
  const push = await fanoutPush(env, embys, nodes, "add-emby");
  return json(201, { ok: true, emby: record, push_results: push });
}

export async function handleUpdateEmby(
  req: JsonRequest,
  env: Env,
  name: string,
): Promise<Response> {
  const [nodes, embys] = await Promise.all([readNodes(env), readEmbys(env)]);
  const emby = embys.embys.find((e) => e.name === name);
  if (!emby) return json(404, { error: "emby 不存在" });

  let changed = false;
  const { backend_url, node_id } = req.body ?? {};
  if (typeof backend_url === "string" && backend_url.trim()) {
    const v = backend_url.trim().replace(/\/$/, "");
    if (v !== emby.backend_url) {
      emby.backend_url = v;
      changed = true;
    }
  }
  if (typeof node_id === "string" && node_id) {
    if (node_id !== emby.node_id) {
      emby.node_id = node_id;
      changed = true;
    }
  }
  const err = validateEmby(emby);
  if (err) return json(400, { error: err });
  const refErr = checkNodeRefs(emby, nodes);
  if (refErr) return json(400, { error: refErr });

  if (!changed) return json(200, { ok: true, emby, skipped: true });
  embys.version += 1;
  await writeEmbys(env, embys);
  const push = await fanoutPush(env, embys, nodes, "update-emby");
  return json(200, { ok: true, emby, push_results: push });
}

export async function handleDeleteEmby(env: Env, name: string): Promise<Response> {
  const [nodes, embys] = await Promise.all([readNodes(env), readEmbys(env)]);
  const before = embys.embys.length;
  embys.embys = embys.embys.filter((e) => e.name !== name);
  if (embys.embys.length === before) {
    return json(404, { error: "emby 不存在" });
  }
  embys.version += 1;
  await writeEmbys(env, embys);
  const push = await fanoutPush(env, embys, nodes, "delete-emby");
  return json(200, { ok: true, push_results: push });
}

export async function handleHealth(env: Env): Promise<Response> {
  const health = await readHealth(env);
  return json(200, health);
}

export async function handleManualSync(env: Env): Promise<Response> {
  const [nodes, embys] = await Promise.all([readNodes(env), readEmbys(env)]);
  const push = await fanoutPush(env, embys, nodes, "manual-resync");
  return json(200, { ok: true, push_results: push });
}

// ---------- helpers ----------

async function fanoutPush(
  env: Env,
  embys: EmbysKV,
  nodes: NodesKV,
  trigger: string,
): Promise<PushResult[]> {
  if (nodes.nodes.length === 0) {
    console.log(`[sync] fanout skipped trigger=${trigger} reason=no-nodes`);
    return [];
  }
  const snapshot = buildSnapshot(embys);
  const results = await pushSnapshotToAll(
    nodes.nodes,
    snapshot,
    env.EMBY_SYNC_TOKEN,
    trigger,
  );
  const baseHealth = await readHealth(env);
  await mergeSyncResults(env, baseHealth, results, nodes.nodes);
  return results;
}

function generateNodeId(nodes: NodesKV): string {
  for (let i = 0; i < 1000; i++) {
    const id = "n_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    if (!nodes.nodes.some((n) => n.id === id)) return id;
  }
  throw new Error("failed to allocate node id");
}

function validateNode(n: { name: string; public_url: string }): string | null {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(n.name)) {
    return "节点名只能包含字母/数字/_/-，长度 1-32";
  }
  return validatePublicUrl(n.public_url);
}

function validatePublicUrl(u: string): string | null {
  if (!u) return "public_url 必填";
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "public_url 必须是 http:// 或 https://";
    }
    if (!parsed.host) return "public_url 缺少 host";
  } catch {
    return "public_url 不合法";
  }
  return null;
}

function validateEmby(e: Omit<EmbyRecord, "created_at">): string | null {
  if (!EMBY_NAME_RE.test(e.name)) {
    return "emby 名只能包含字母/数字/_/-，长度 1-32";
  }
  if (RESERVED_NAMES.has(e.name.toLowerCase())) {
    return `emby 名 '${e.name}' 是保留字`;
  }
  if (!e.backend_url) return "backend_url 必填";
  try {
    const parsed = new URL(e.backend_url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "backend_url 必须是 http:// 或 https://";
    }
  } catch {
    return "backend_url 不合法";
  }
  if (!e.node_id) return "node_id 必填";
  return null;
}

function checkNodeRefs(
  e: Omit<EmbyRecord, "created_at">,
  nodes: NodesKV,
): string | null {
  if (!nodes.nodes.some((n) => n.id === e.node_id)) {
    return `node_id '${e.node_id}' 不存在`;
  }
  return null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
