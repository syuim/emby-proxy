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
  ispMatched: boolean;
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

/**
 * per-emby 组路由：组内所有 node 并发存活探测（复用非对称 TTL 缓存），
 * 在「存活且匹配入口 ISP」的子集里纯随机；组不存在/无成员/全灭返回 null
 * （由调用方走 Worker local 兜底，不写 config_meta，与全局 failover 互不干扰）。
 */
export async function chooseNodeFromGroup(
  env: Env,
  groupId: number,
  nodes: NodeRecord[],
  isp: IspClass,
): Promise<GroupPick | null> {
  const memberIds = await readGroupNodeIds(env, groupId);
  if (memberIds.length === 0) return null;

  const members = nodes.filter((n) => memberIds.includes(n.id));
  if (members.length === 0) return null;

  const results = await Promise.all(
    members.map(async (n) => ({ node: n, alive: await probeAlive(n) })),
  );
  const alive = results.filter((r) => r.alive).map((r) => r.node);
  if (alive.length === 0) return null;

  const { pool, matched } = filterGroupPool(alive, isp);
  // overseas 入口：组内无匹配节点时不回退全部，走 Worker local
  if (isp === "overseas" && !matched) return null;
  const pick = pool[Math.floor(Math.random() * pool.length)]!;
  return {
    node: pick,
    aliveNames: alive.map((n) => n.name),
    poolNames: pool.map((n) => n.name),
    ispMatched: matched,
  };
}
