import { classifyClientIsp } from "./group";
import { readTgConfig } from "./storage";
import type { IspClass } from "./isp";
import type { Env } from "./types";

// ---------- Telegram 发送 ----------

export interface TgSendResult {
  ok: boolean;
  error?: string;
}

// 纯文本消息（不用 Markdown parse_mode：UA/路径里的 _ 等字符会让 TG 拒收 400）
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<TgSendResult> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await resp.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;
    if (!resp.ok || !data?.ok) {
      return { ok: false, error: data?.description || `HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------- 新 IP 通知消息 ----------

const ISP_LABELS: Record<IspClass, string> = {
  ct: "电信",
  cu: "联通",
  cm: "移动",
  overseas: "海外",
};

export interface NewIpMessageInput {
  ip: string;
  target: string;
  method: string;
  path: string;
  isp: IspClass;
  asn?: number | null;
  asOrganization?: string | null;
  country?: string | null;
  city?: string | null;
  ua?: string | null;
  now: Date;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function buildNewIpMessage(input: NewIpMessageInput): string {
  const lines = ["🆕 Emby Proxy 新 IP 接入", `IP: ${input.ip}`];
  const org = [input.asn ? `AS${input.asn}` : "", input.asOrganization ?? ""]
    .filter(Boolean)
    .join(" ");
  const place = [ISP_LABELS[input.isp], org, [input.country, input.city].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(" · ");
  if (place) lines.push(`归属: ${place}`);
  lines.push(`目标: ${input.target} ${input.method} ${clip(input.path, 200)}`);
  if (input.ua) lines.push(`UA: ${clip(input.ua, 120)}`);
  lines.push(`时间: ${input.now.toISOString()}`);
  return clip(lines.join("\n"), 4000);
}

// ---------- 新 IP 检测（isolate 内缓存 + D1 去重） ----------
// D1 是唯一真源：INSERT ON CONFLICT DO NOTHING 的 meta.changes 判「真新 IP」，
// 跨 isolate 并发不会重复通知；isolate 内 Set 只用来免掉已记录 IP 的 D1 往返。

const seenIpCache = new Set<string>();
const SEEN_IP_CACHE_MAX = 2000;
const CLEANUP_PROBABILITY = 1 / 200;
const SEEN_IP_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const TG_CONFIG_TTL_MS = 60_000;

let tgConfigCache: { botToken: string; chatId: string; at: number } | null = null;

export function __resetNotifyStateForTests(): void {
  seenIpCache.clear();
  tgConfigCache = null;
}

async function readTgConfigCached(env: Env): Promise<{ botToken: string; chatId: string }> {
  if (tgConfigCache && Date.now() - tgConfigCache.at < TG_CONFIG_TTL_MS) return tgConfigCache;
  const cfg = await readTgConfig(env);
  tgConfigCache = { ...cfg, at: Date.now() };
  return cfg;
}

// 调度入口：整条链路（含 D1 写入与 TG 发送）放 waitUntil，不占客户端请求延迟
export function notifyNewIp(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  target: string,
): void {
  const task = trackNewIp(request, env, target).catch((e) => {
    console.log(`[notify] new-ip error: ${(e as Error).message}`);
  });
  if (ctx) ctx.waitUntil(task);
}

async function trackNewIp(request: Request, env: Env, target: string): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || ip === "-") return;
  if (seenIpCache.has(ip)) return;

  // 未配置 TG 时不记录：配置前的访问不算「已见」，配置后仍能收到其通知
  const { botToken, chatId } = await readTgConfigCached(env);
  if (!botToken || !chatId) return;

  const res = await env.EMBY_DB.prepare(
    "INSERT INTO seen_ips(ip, first_seen, target) VALUES(?,?,?) ON CONFLICT(ip) DO NOTHING",
  )
    .bind(ip, new Date().toISOString(), target)
    .run();
  if (seenIpCache.size >= SEEN_IP_CACHE_MAX) seenIpCache.clear();
  seenIpCache.add(ip);
  if (res.meta.changes === 0) return;

  console.log(`[notify] new-ip ip=${ip} target=${target}`);
  const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
  const text = buildNewIpMessage({
    ip,
    target,
    method: request.method,
    path: new URL(request.url).pathname,
    isp: classifyClientIsp(request),
    asn: cf?.asn,
    asOrganization: cf?.asOrganization,
    country: cf?.country,
    city: cf?.city,
    ua: request.headers.get("User-Agent"),
    now: new Date(),
  });
  const sent = await sendTelegramMessage(botToken, chatId, text);
  console.log(`[notify] new-ip ip=${ip} tg=${sent.ok ? "sent" : "failed: " + sent.error}`);

  // 概率清理：seen_ips 无上限增长，偶发删掉 180 天未见的旧 IP（重新连入会再通知一次）
  if (Math.random() < CLEANUP_PROBABILITY) {
    const cutoff = new Date(Date.now() - SEEN_IP_RETENTION_MS).toISOString();
    await env.EMBY_DB.prepare("DELETE FROM seen_ips WHERE first_seen < ?").bind(cutoff).run();
  }
}
