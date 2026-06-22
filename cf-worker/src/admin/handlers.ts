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
  nodes.version += 1;
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

  const { name, public_url } = req.body ?? {};
  if (typeof name === "string" && name.trim()) {
    const v = name.trim();
    if (nodes.nodes.some((n) => n.id !== id && n.name === v)) {
      return json(400, { error: `节点名 '${v}' 已被占用` });
    }
    node.name = v;
  }
  if (typeof public_url === "string" && public_url.trim()) {
    const v = public_url.trim().replace(/\/$/, "");
    const err = validatePublicUrl(v);
    if (err) return json(400, { error: err });
    if (nodes.nodes.some((n) => n.id !== id && n.public_url === v)) {
      return json(400, { error: `URL '${v}' 已被占用` });
    }
    node.public_url = v;
  }
  nodes.version += 1;
  await writeNodes(env, nodes);
  return json(200, { ok: true, node });
}

export async function handleDeleteNode(env: Env, id: string): Promise<Response> {
  const [nodes, embys] = await Promise.all([readNodes(env), readEmbys(env)]);
  const refs = embys.embys.filter(
    (e) => e.primary_node_id === id || e.backup_node_ids.includes(id),
  );
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
  nodes.version += 1;
  await writeNodes(env, nodes);
  return json(200, { ok: true });
}

export async function handleListEmbys(env: Env): Promise<Response> {
  const embys = await readEmbys(env);
  return json(200, embys);
}

export async function handleAddEmby(req: JsonRequest, env: Env): Promise<Response> {
  const { name, backend_url, primary_node_id, backup_node_ids } = req.body ?? {};
  const trimmed: Omit<EmbyRecord, "created_at"> = {
    name: typeof name === "string" ? name.trim() : "",
    backend_url:
      typeof backend_url === "string" ? backend_url.trim().replace(/\/$/, "") : "",
    primary_node_id: typeof primary_node_id === "string" ? primary_node_id : "",
    backup_node_ids: Array.isArray(backup_node_ids)
      ? backup_node_ids.filter((x: unknown) => typeof x === "string")
      : [],
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
  const push = await fanoutPush(env, embys, nodes);
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

  const { backend_url, primary_node_id, backup_node_ids } = req.body ?? {};
  if (typeof backend_url === "string" && backend_url.trim()) {
    emby.backend_url = backend_url.trim().replace(/\/$/, "");
  }
  if (typeof primary_node_id === "string" && primary_node_id) {
    emby.primary_node_id = primary_node_id;
  }
  if (Array.isArray(backup_node_ids)) {
    emby.backup_node_ids = backup_node_ids.filter(
      (x: unknown): x is string => typeof x === "string",
    );
  }
  const err = validateEmby(emby);
  if (err) return json(400, { error: err });
  const refErr = checkNodeRefs(emby, nodes);
  if (refErr) return json(400, { error: refErr });

  embys.version += 1;
  await writeEmbys(env, embys);
  const push = await fanoutPush(env, embys, nodes);
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
  const push = await fanoutPush(env, embys, nodes);
  return json(200, { ok: true, push_results: push });
}

export async function handleHealth(env: Env): Promise<Response> {
  const health = await readHealth(env);
  return json(200, health);
}

export async function handleManualSync(env: Env): Promise<Response> {
  const [nodes, embys] = await Promise.all([readNodes(env), readEmbys(env)]);
  const push = await fanoutPush(env, embys, nodes);
  return json(200, { ok: true, push_results: push });
}

/**
 * 整体替换 KV：覆盖 nodes + embys，立即推所有节点。
 * Body: {nodes: NodeRecord[], embys: EmbyRecord[]}
 */
export async function handleImport(req: JsonRequest, env: Env): Promise<Response> {
  const body = req.body;
  if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.embys)) {
    return json(400, { error: "需提供 {nodes:[], embys:[]}" });
  }
  const incomingNodes = body.nodes as Partial<NodeRecord>[];
  const incomingEmbys = body.embys as Partial<EmbyRecord>[];

  const nodesKV: NodesKV = { version: 1, nodes: [] };
  for (const n of incomingNodes) {
    const id = typeof n.id === "string" && n.id ? n.id : generateNodeId(nodesKV);
    const cand: NodeRecord = {
      id,
      name: (n.name ?? "").toString().trim(),
      public_url: (n.public_url ?? "").toString().trim().replace(/\/$/, ""),
      created_at: n.created_at ?? new Date().toISOString(),
    };
    const err = validateNode(cand);
    if (err) return json(400, { error: `节点 ${cand.name || cand.id}: ${err}` });
    if (nodesKV.nodes.some((x) => x.id === cand.id || x.name === cand.name)) {
      return json(400, { error: `节点重复：${cand.name}` });
    }
    nodesKV.nodes.push(cand);
  }

  const embysKV: EmbysKV = { version: 1, embys: [] };
  for (const e of incomingEmbys) {
    const cand: EmbyRecord = {
      name: (e.name ?? "").toString().trim(),
      backend_url: (e.backend_url ?? "").toString().trim().replace(/\/$/, ""),
      primary_node_id: (e.primary_node_id ?? "").toString(),
      backup_node_ids: Array.isArray(e.backup_node_ids)
        ? e.backup_node_ids.filter((x: unknown): x is string => typeof x === "string")
        : [],
      created_at: e.created_at ?? new Date().toISOString(),
    };
    const err = validateEmby(cand);
    if (err) return json(400, { error: `emby ${cand.name}: ${err}` });
    const refErr = checkNodeRefs(cand, nodesKV);
    if (refErr) return json(400, { error: `emby ${cand.name}: ${refErr}` });
    if (embysKV.embys.some((x) => x.name === cand.name)) {
      return json(400, { error: `emby 重复：${cand.name}` });
    }
    embysKV.embys.push(cand);
  }

  await writeNodes(env, nodesKV);
  await writeEmbys(env, embysKV);

  const push = await fanoutPush(env, embysKV, nodesKV);
  return json(200, {
    ok: true,
    nodes: nodesKV.nodes.length,
    embys: embysKV.embys.length,
    push_results: push,
  });
}

// ---------- helpers ----------

async function fanoutPush(
  env: Env,
  embys: EmbysKV,
  nodes: NodesKV,
): Promise<PushResult[]> {
  if (nodes.nodes.length === 0) return [];
  const snapshot = buildSnapshot(embys);
  const results = await pushSnapshotToAll(nodes.nodes, snapshot, env.EMBY_SYNC_TOKEN);
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
  if (!e.primary_node_id) return "primary_node_id 必填";
  return null;
}

function checkNodeRefs(
  e: Omit<EmbyRecord, "created_at">,
  nodes: NodesKV,
): string | null {
  if (!nodes.nodes.some((n) => n.id === e.primary_node_id)) {
    return `primary_node_id '${e.primary_node_id}' 不存在`;
  }
  for (const id of e.backup_node_ids) {
    if (!nodes.nodes.some((n) => n.id === id)) {
      return `backup_node_id '${id}' 不存在`;
    }
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
