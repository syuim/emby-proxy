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
  // 命中来源：primary=主池按入口网络匹配；backup=备用池（主池不可用时）；
  // fallback=两级均无网络匹配时的错配兜底（国内网络不断流；overseas 无此态）
  stage: "primary" | "backup" | "fallback";
}

// ISP 是软过滤：node 未标注任何 ISP = 全兼容；返回「存活且匹配入口网络」的子集。
// 匹配为空的处理在调用方按优先级决策（启用备用池 / 最后错配兜底或 local）。
export function matchIspPool(alive: NodeRecord[], isp: IspClass): NodeRecord[] {
  return alive.filter(
    (n) => n.isp_tags.length === 0 || n.isp_tags.includes(isp),
  );
}

function pickRandom(pool: NodeRecord[]): NodeRecord {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * per-emby 组路由：两级池（主成员 / 备用节点）按优先级选择——
 * 1. 主池存活且匹配入口网络 → 纯随机（stage=primary）；
 * 2. 主池在当前网络下不可用（全部失效 / 禁用 / 无主成员 / 存活但无 ISP 匹配）→ 备用池同规则选择（stage=backup）；
 * 3. 两级都无网络匹配：overseas 入口不跨网错配返回 null（Worker local），
 *    其余入口从主∪备全部存活中随机错配兜底（stage=fallback，宁可错配不断流）；
 * 4. 全部失效 → null（由调用方走 Worker local 兜底，不写 config_meta，与全局 failover 互不干扰）。
 */
export async function chooseNodeFromGroup(
  env: Env,
  groupId: number,
  nodes: NodeRecord[],
  isp: IspClass,
): Promise<GroupPick | null> {
  const { primary, backup } = await readGroupNodeIds(env, groupId);

  const candidates = nodes.filter(
    (n) => primary.includes(n.id) || backup.includes(n.id),
  );
  if (candidates.length === 0) return null;

  const results = await Promise.all(
    candidates.map(async (n) => ({ node: n, alive: await probeAlive(n) })),
  );
  const alive = results.filter((r) => r.alive).map((r) => r.node);
  if (alive.length === 0) return null;

  const alivePrimary = alive.filter((n) => primary.includes(n.id));
  const matchedPrimary = matchIspPool(alivePrimary, isp);
  if (matchedPrimary.length > 0) {
    return {
      node: pickRandom(matchedPrimary),
      aliveNames: alivePrimary.map((n) => n.name),
      poolNames: matchedPrimary.map((n) => n.name),
      stage: "primary",
    };
  }

  const aliveBackup = alive.filter((n) => backup.includes(n.id));
  const matchedBackup = matchIspPool(aliveBackup, isp);
  if (matchedBackup.length > 0) {
    return {
      node: pickRandom(matchedBackup),
      aliveNames: aliveBackup.map((n) => n.name),
      poolNames: matchedBackup.map((n) => n.name),
      stage: "backup",
    };
  }

  // 主∪备有存活但都匹配不上入口网络：overseas 宁可 local 也不跨网错配
  if (isp === "overseas") return null;
  return {
    node: pickRandom(alive),
    aliveNames: alive.map((n) => n.name),
    poolNames: alive.map((n) => n.name),
    stage: "fallback",
  };
}
