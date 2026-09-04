import { EMBY_NAME_RE, RESERVED_NAMES } from "../constants";
import { isIspTag } from "../isp";
import {
  readConfigMeta,
  readEmbys,
  readGroups,
  readGroupsWithMembers,
  readHealth,
  readNodes,
  writeHealth,
} from "../storage";
import { buildSnapshot, pushSnapshotToAll } from "../sync";
import { immediateProbe, mergeSyncResults, runHealthCycle } from "../health";
import type {
  EmbyRecord,
  EmbysKV,
  Env,
  NodeRecord,
  NodesKV,
  ProxyGroup,
  PushResult,
} from "../types";

interface JsonRequest {
  url: URL;
  body: any;
}

const GROUP_NAME_MAX = 32;

const ISP_TAG_ORDER = ["ct", "cu", "cm", "overseas"];

function parseIspTagsInput(v: unknown): string[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string" || !isIspTag(x)) return null;
    seen.add(x);
  }
  return ISP_TAG_ORDER.filter((t) => seen.has(t));
}

export async function handleListNodes(env: Env): Promise<Response> {
  const [nodes, health] = await Promise.all([readNodes(env), readHealth(env)]);
  return json(200, { ...nodes, health: health.nodes });
}

export async function handleGetConfig(env: Env): Promise<Response> {
  const config = await readConfigMeta(env);
  return json(200, { proxy_mode: config.proxy_mode });
}

export async function handleUpdateConfig(req: JsonRequest, env: Env): Promise<Response> {
  const { proxy_mode } = req.body ?? {};
  if (!["node", "local", "direct"].includes(proxy_mode)) {
    return json(400, { error: "proxy_mode 必须为 node / local / direct" });
  }
  await env.EMBY_DB.prepare("UPDATE config_meta SET proxy_mode = ? WHERE id = 1").bind(proxy_mode).run();
  const config = await readConfigMeta(env);
  return json(200, { ok: true, proxy_mode: config.proxy_mode });
}

export async function handleAddNode(req: JsonRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { name, public_url } = req.body ?? {};
  if (typeof name !== "string" || typeof public_url !== "string") {
    return json(400, { error: "name 与 public_url 必填" });
  }
  const ispTags = parseIspTagsInput(req.body?.isp_tags);
  if (ispTags === null) {
    return json(400, { error: "isp_tags 只能包含 ct / cu / cm / overseas" });
  }
  const trimmed = { name: name.trim(), public_url: public_url.trim().replace(/\/$/, "") };
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
    public_url: trimmed.public_url,
    created_at: new Date().toISOString(),
    sort_order: nodes.nodes.reduce((m, n) => Math.max(m, n.sort_order), -1) + 1,
    isp_tags: ispTags ?? [],
  };
  nodes.nodes.push(newNode);
  const stmts: D1PreparedStatement[] = [
    env.EMBY_DB.prepare(
      "INSERT INTO nodes(id, name, public_url, created_at, sort_order, isp_tags) VALUES(?,?,?,?,?,?)",
    ).bind(newNode.id, newNode.name, newNode.public_url, newNode.created_at, newNode.sort_order, JSON.stringify(newNode.isp_tags)),
  ];
  await env.EMBY_DB.batch(stmts);
  // 添加节点后立即探测，写入健康状态
  const probeTask = (async () => {
    const nodeHealth = await immediateProbe(newNode, env.EMBY_SYNC_TOKEN, 3);
    const health = await readHealth(env);
    health.nodes[newNode.id] = nodeHealth;
    await writeHealth(env, health);
  })();
  ctx.waitUntil(probeTask);
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
  let configChanged = false; // name/public_url 变化影响探活与推送；isp_tags 只影响 Worker 路由
  const { name, public_url } = req.body ?? {};
  if (typeof name === "string" && name.trim()) {
    const v = name.trim();
    if (nodes.nodes.some((n) => n.id !== id && n.name === v)) {
      return json(400, { error: `节点名 '${v}' 已被占用` });
    }
    if (v !== node.name) {
      node.name = v;
      changed = true;
      configChanged = true;
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
      configChanged = true;
    }
  }
  const ispTags = parseIspTagsInput(req.body?.isp_tags);
  if (ispTags === null) {
    return json(400, { error: "isp_tags 只能包含 ct / cu / cm / overseas" });
  }
  if (ispTags !== null && JSON.stringify(ispTags) !== JSON.stringify(node.isp_tags)) {
    node.isp_tags = ispTags;
    changed = true;
  }
  if (!changed) return json(200, { ok: true, node, skipped: true });
  const stmts: D1PreparedStatement[] = [
    env.EMBY_DB.prepare(
      "UPDATE nodes SET name = ?, public_url = ?, isp_tags = ? WHERE id = ?",
    ).bind(node.name, node.public_url, JSON.stringify(node.isp_tags), id),
  ];
  await env.EMBY_DB.batch(stmts);
  // 节点 URL 变更不影响 emby 配置（节点上仍是同一份 snapshot），
  // 但探活/推送会指向新地址，故推一次让各节点版本对齐、触发 cron 用新 URL 探测。
  // isp_tags 仅 Worker 路由使用，不进入 sync 协议，单独变更无需推送。
  if (configChanged) {
    const push = await fanoutPush(env, await readEmbys(env), nodes, "update-node");
    return json(200, { ok: true, node, push_results: push });
  }
  return json(200, { ok: true, node });
}

export async function handleDeleteNode(env: Env, id: string): Promise<Response> {
  const nodes = await readNodes(env);
  if (!nodes.nodes.some((n) => n.id === id)) {
    return json(404, { error: "节点不存在" });
  }
  // 只清组关联与节点记录；embys.node_id/home_node_id 解引用已随全局节点机制移除，
  // health 残留行由 cron 的 staleIds 清理
  await env.EMBY_DB.batch([
    env.EMBY_DB.prepare("DELETE FROM node_groups WHERE node_id = ?").bind(id),
    env.EMBY_DB.prepare("DELETE FROM nodes WHERE id = ?").bind(id),
  ]);
  return json(200, { ok: true });
}

export async function handleListEmbys(env: Env): Promise<Response> {
  const embys = await readEmbys(env);
  return json(200, embys);
}

export async function handleAddEmby(req: JsonRequest, env: Env): Promise<Response> {
  const { name, backend_url } = req.body ?? {};
  const trimmed: Omit<EmbyRecord, "created_at" | "group_id"> = {
    name: typeof name === "string" ? name.trim() : "",
    backend_url:
      typeof backend_url === "string" ? backend_url.trim().replace(/\/$/, "") : "",
  };
  const err = validateEmby(trimmed);
  if (err) return json(400, { error: err });

  const [nodes, embys, groups] = await Promise.all([readNodes(env), readEmbys(env), readGroups(env)]);

  // 未传 group_id = 默认不绑组；显式传了才校验存在性
  let groupId: number | null = null;
  if (req.body?.group_id !== undefined) {
    const gid = await validateGroupIdInput(req.body.group_id, groups);
    if (gid === undefined) return json(400, { error: "group_id 不存在" });
    groupId = gid;
  }

  if (embys.embys.some((e) => e.name === trimmed.name)) {
    return json(400, { error: `emby '${trimmed.name}' 已存在` });
  }
  const record: EmbyRecord = { ...trimmed, group_id: groupId, created_at: new Date().toISOString() };
  // 定向 INSERT + version 原子递增，避免整表 DELETE + 重插的并发丢数据
  await env.EMBY_DB.batch([
    env.EMBY_DB.prepare(
      "INSERT INTO embys(name, backend_url, node_id, home_node_id, group_id, created_at) VALUES(?,?,?,?,?,?)",
    ).bind(record.name, record.backend_url, '', '', record.group_id, record.created_at),
    env.EMBY_DB.prepare("UPDATE config_meta SET version = version + 1 WHERE id = 1"),
  ]);
  embys.version += 1;
  embys.embys.push(record);
  const push = await fanoutPush(env, embys, nodes, "add-emby");
  return json(201, { ok: true, emby: record, push_results: push });
}

export async function handleUpdateEmby(
  req: JsonRequest,
  env: Env,
  name: string,
): Promise<Response> {
  const [nodes, embys, groups] = await Promise.all([readNodes(env), readEmbys(env), readGroups(env)]);
  const emby = embys.embys.find((e) => e.name === name);
  if (!emby) return json(404, { error: "emby 不存在" });

  let changed = false;
  const { name: newName, backend_url } = req.body ?? {};
  if (typeof newName === "string" && newName.trim() && newName.trim() !== name) {
    const v = newName.trim();
    if (embys.embys.some((e) => e.name === v)) {
      return json(400, { error: `emby 名 '${v}' 已存在` });
    }
    const err = validateEmby({ ...emby, name: v });
    if (err) return json(400, { error: err });
    emby.name = v;
    changed = true;
  }
  if (typeof backend_url === "string" && backend_url.trim()) {
    const v = backend_url.trim().replace(/\/$/, "");
    if (v !== emby.backend_url) {
      emby.backend_url = v;
      changed = true;
    }
  }
  if (req.body?.group_id !== undefined) {
    const groupId = await validateGroupIdInput(req.body.group_id, groups);
    if (groupId === undefined) return json(400, { error: "group_id 不存在" });
    if (groupId !== emby.group_id) {
      emby.group_id = groupId;
      changed = true;
    }
  }
  const err = validateEmby(emby);
  if (err) return json(400, { error: err });

  if (!changed) return json(200, { ok: true, emby, skipped: true });
  // 定向 UPDATE（含重命名）+ version 原子递增。
  // group_id 只影响 Worker 路由（不进节点 snapshot），变更仍 bump version 无副作用但
  // 会产生一次无谓 fanout；为保持 fanout 只在内容变化时发生，group 变化单独走 UPDATE。
  if (changed && !bodyHasContentChange(req.body)) {
    await env.EMBY_DB.prepare(
      "UPDATE embys SET group_id = ? WHERE name = ?",
    ).bind(emby.group_id, name).run();
    return json(200, { ok: true, emby, group_updated: true });
  }
  // 定向 UPDATE（含重命名）+ version 原子递增
  await env.EMBY_DB.batch([
    env.EMBY_DB.prepare("UPDATE embys SET name = ?, backend_url = ?, group_id = ? WHERE name = ?").bind(
      emby.name, emby.backend_url, emby.group_id, name,
    ),
    env.EMBY_DB.prepare("UPDATE config_meta SET version = version + 1 WHERE id = 1"),
  ]);
  embys.version += 1;
  const push = await fanoutPush(env, embys, nodes, "update-emby");
  return json(200, { ok: true, emby, push_results: push });
}

// group_id 输入校验：null（解绑）合法；数字必须存在。返回 undefined 表示非法。
async function validateGroupIdInput(
  v: unknown,
  groups: ProxyGroup[],
): Promise<number | null | undefined> {
  if (v === null) return null;
  if (typeof v === "number" && Number.isInteger(v)) {
    return groups.some((g) => g.id === v) ? v : undefined;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isInteger(n) && groups.some((g) => g.id === n)) return n;
  }
  return undefined;
}

// true = 请求体只改了 group_id（不走 fanout / bump version）
function bodyHasContentChange(body: any): boolean {
  return (
    (typeof body?.name === "string" && body.name.trim() !== "") ||
    (typeof body?.backend_url === "string" && body.backend_url.trim() !== "")
  );
}

export async function handleDeleteEmby(env: Env, name: string): Promise<Response> {
  const [nodes, embys] = await Promise.all([readNodes(env), readEmbys(env)]);
  const before = embys.embys.length;
  embys.embys = embys.embys.filter((e) => e.name !== name);
  if (embys.embys.length === before) {
    return json(404, { error: "emby 不存在" });
  }
  // 定向 DELETE + version 原子递增
  await env.EMBY_DB.batch([
    env.EMBY_DB.prepare("DELETE FROM embys WHERE name = ?").bind(name),
    env.EMBY_DB.prepare("UPDATE config_meta SET version = version + 1 WHERE id = 1"),
  ]);
  embys.version += 1;
  const push = await fanoutPush(env, embys, nodes, "delete-emby");
  return json(200, { ok: true, push_results: push });
}

// ---------- 代理组 ----------
// 组/成员/isp 标签只影响 Worker 路由，不进节点 snapshot → 全部不 bump version、不 fanout。

export async function handleListGroups(env: Env): Promise<Response> {
  const groups = await readGroupsWithMembers(env);
  return json(200, { groups });
}

export async function handleCreateGroup(req: JsonRequest, env: Env): Promise<Response> {
  const { name } = req.body ?? {};
  const v = typeof name === "string" ? name.trim() : "";
  if (!v || v.length > GROUP_NAME_MAX) {
    return json(400, { error: `组名必填且不超过 ${GROUP_NAME_MAX} 字符` });
  }
  const [groups, nodes] = await Promise.all([readGroups(env), readNodes(env)]);
  if (groups.some((g) => g.name === v)) {
    return json(400, { error: `组 '${v}' 已存在` });
  }
  let nodeIds: string[] = [];
  if (req.body?.node_ids !== undefined) {
    if (!Array.isArray(req.body.node_ids) || req.body.node_ids.some((x: unknown) => typeof x !== "string")) {
      return json(400, { error: "node_ids 必须是节点 id 数组" });
    }
    const known = new Set(nodes.nodes.map((n) => n.id));
    const unknown = req.body.node_ids.filter((x: string) => !known.has(x));
    if (unknown.length > 0) {
      return json(400, { error: `未知节点: ${unknown.join(", ")}` });
    }
    nodeIds = req.body.node_ids as string[];
  }
  const stmts: D1PreparedStatement[] = [
    env.EMBY_DB.prepare(
      "INSERT INTO proxy_groups(name, created_at) VALUES(?,?)",
    ).bind(v, new Date().toISOString()),
  ];
  for (const nid of nodeIds) {
    stmts.push(
      env.EMBY_DB.prepare(
        "INSERT INTO node_groups(node_id, group_id) VALUES(?, (SELECT id FROM proxy_groups WHERE name = ?))",
      ).bind(nid, v),
    );
  }
  await env.EMBY_DB.batch(stmts);
  const created = (await readGroups(env)).find((g) => g.name === v);
  return json(201, { ok: true, group: { ...created!, node_ids: nodeIds } });
}

export async function handleUpdateGroup(
  req: JsonRequest,
  env: Env,
  id: number,
): Promise<Response> {
  const [groups, nodes, members] = await Promise.all([
    readGroups(env),
    readNodes(env),
    readGroupsWithMembers(env),
  ]);
  const group = groups.find((g) => g.id === id);
  if (!group) return json(404, { error: "组不存在" });

  const stmts: D1PreparedStatement[] = [];
  const { name, node_ids } = req.body ?? {};

  if (name !== undefined) {
    const v = typeof name === "string" ? name.trim() : "";
    if (!v || v.length > GROUP_NAME_MAX) {
      return json(400, { error: `组名必填且不超过 ${GROUP_NAME_MAX} 字符` });
    }
    if (groups.some((g) => g.id !== id && g.name === v)) {
      return json(400, { error: `组 '${v}' 已存在` });
    }
    if (v !== group.name) {
      stmts.push(env.EMBY_DB.prepare("UPDATE proxy_groups SET name = ? WHERE id = ?").bind(v, id));
      group.name = v;
    }
  }

  let membershipChanged = false;
  if (node_ids !== undefined) {
    if (!Array.isArray(node_ids) || node_ids.some((x) => typeof x !== "string")) {
      return json(400, { error: "node_ids 必须是节点 id 数组" });
    }
    const known = new Set(nodes.nodes.map((n) => n.id));
    const unknown = node_ids.filter((x: string) => !known.has(x));
    if (unknown.length > 0) {
      return json(400, { error: `未知节点: ${unknown.join(", ")}` });
    }
    const cur = new Set(members.find((g) => g.id === id)?.node_ids ?? []);
    const next = new Set(node_ids as string[]);
    if (cur.size !== next.size || [...cur].some((x) => !next.has(x))) {
      stmts.push(env.EMBY_DB.prepare("DELETE FROM node_groups WHERE group_id = ?").bind(id));
      for (const nid of next) {
        stmts.push(
          env.EMBY_DB.prepare("INSERT INTO node_groups(node_id, group_id) VALUES(?,?)").bind(nid, id),
        );
      }
      membershipChanged = true;
    }
  }

  if (stmts.length === 0) return json(200, { ok: true, skipped: true });
  await env.EMBY_DB.batch(stmts);
  return json(200, {
    ok: true,
    group: { id, name: group.name, created_at: group.created_at, node_ids: membershipChanged ? (node_ids as string[]) : undefined },
  });
}

export async function handleDeleteGroup(env: Env, id: number): Promise<Response> {
  const groups = await readGroups(env);
  const group = groups.find((g) => g.id === id);
  if (!group) return json(404, { error: "组不存在" });
  // 解绑引用 emby 后删除组。解绑只影响 Worker 路由，不 bump version（节点 snapshot 不含组）
  await env.EMBY_DB.batch([
    env.EMBY_DB.prepare("UPDATE embys SET group_id = NULL WHERE group_id = ?").bind(id),
    env.EMBY_DB.prepare("DELETE FROM node_groups WHERE group_id = ?").bind(id),
    env.EMBY_DB.prepare("DELETE FROM proxy_groups WHERE id = ?").bind(id),
  ]);
  return json(200, { ok: true });
}

export async function handleHealth(env: Env): Promise<Response> {
  const health = await readHealth(env);
  return json(200, health);
}

export async function handleProbe(env: Env, ctx: ExecutionContext): Promise<Response> {
  await runHealthCycle(env, ctx, true); // force=true → 绕过节流，始终真实探测
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
  await mergeSyncResults(env, baseHealth, results);
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
  // 节点名规则与 emby 名相同，复用同一常量避免漂移
  if (!EMBY_NAME_RE.test(n.name)) {
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

function validateEmby(e: Omit<EmbyRecord, "created_at" | "group_id">): string | null {
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
