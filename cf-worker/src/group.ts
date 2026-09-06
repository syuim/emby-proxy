import { probeAlive } from "./alive";
import { classifyIsp, type IspClass } from "./isp";
import { readGroupNodeIds } from "./storage";
import type { Env, NodeRecord } from "./types";

// 从 CF 请求属性取入口网络：asn 命中本地表；未命中用组织名二次兜底
export function classifyClientIsp(request: Request): IspClass {
  const cf = (
    request as Request & { cf?: { asn?: number; asOrganization?: string } }
  ).cf;
  return classifyIsp(cf?.asn, cf?.asOrganization);
}

export interface GroupPick {
  node: NodeRecord;
  aliveNames: string[];
  poolNames: string[];
  // 命中来源：primary=主成员池 backup=备用池（主成员全部失效时才启用）
  stage: "primary" | "backup";
}

export interface GroupPool {
  pool: NodeRecord[];
  // false 表示发生了 ISP 无匹配回退（池 = 全部存活 node）
  matched: boolean;
}

// ISP 是软过滤：node 未标注任何 ISP = 全兼容。
// 匹配集合为空（组内没有该 ISP 的 node）时回退全部存活 node，宁可错配不断流（overseas 除外）。
export function filterGroupPool(alive: NodeRecord[], isp: IspClass): GroupPool {
  const matched = alive.filter(
    (n) => n.isp_tags.length === 0 || n.isp_tags.includes(isp),
  );
  return matched.length > 0
    ? { pool: matched, matched: true }
    : { pool: alive, matched: false };
}

type PoolPick =
  | { kind: "picked"; pick: GroupPick }
  | { kind: "allDead" }
  // overseas 入口下存活 node 均无匹配（宁可 local 也不跨网错配）
  | { kind: "noMatch" };

// 对候选 node 池：并发存活探测（复用非对称 TTL 缓存）→ ISP 软过滤 → 纯随机选一。
async function pickFromPool(
  candidates: NodeRecord[],
  isp: IspClass,
  stage: GroupPick["stage"],
): Promise<PoolPick> {
  if (candidates.length === 0) return { kind: "allDead" };

  const results = await Promise.all(
    candidates.map(async (n) => ({ node: n, alive: await probeAlive(n) })),
  );
  const alive = results.filter((r) => r.alive).map((r) => r.node);
  if (alive.length === 0) return { kind: "allDead" };

  const { pool, matched } = filterGroupPool(alive, isp);
  // overseas 入口：组内无匹配节点时不回退全部，走 Worker local
  if (isp === "overseas" && !matched) return { kind: "noMatch" };
  const pick = pool[Math.floor(Math.random() * pool.length)]!;
  return {
    kind: "picked",
    pick: {
      node: pick,
      aliveNames: alive.map((n) => n.name),
      poolNames: pool.map((n) => n.name),
      stage,
    },
  };
}

/**
 * per-emby 组路由：主成员并发存活探测后在「存活且匹配入口 ISP」的子集里纯随机；
 * 主成员全部失效（含 disabled / 主池为空）时启用备用池再走同一套选择；
 * 备用也全部失效返回 null（由调用方走 Worker local 兜底，不写 config_meta，与全局 failover 互不干扰）。
 * overseas 入口在主池存活但无匹配时不启用备用（维持现状直接 local）。
 */
export async function chooseNodeFromGroup(
  env: Env,
  groupId: number,
  nodes: NodeRecord[],
  isp: IspClass,
): Promise<GroupPick | null> {
  const { primary, backup } = await readGroupNodeIds(env, groupId);

  const primaryCandidates = nodes.filter((n) => primary.includes(n.id));
  const primaryPick = await pickFromPool(primaryCandidates, isp, "primary");
  if (primaryPick.kind === "picked") return primaryPick.pick;
  // 主池因 overseas 无匹配失败（存活但无匹配）→ 不启用备用
  if (primaryPick.kind === "noMatch") return null;

  // 主成员全部失效 / 无主成员 → 组配置了备用节点则启用备用池
  const backupCandidates = nodes.filter((n) => backup.includes(n.id));
  const backupPick = await pickFromPool(backupCandidates, isp, "backup");
  return backupPick.kind === "picked" ? backupPick.pick : null;
}
