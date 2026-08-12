export const SYNC_PATH = "/admin/sync";
export const STATUS_PATH = "/admin/status";
export const NODE_HEALTH_PATH = "/__health";

export const HEALTH_PROBE_TIMEOUT_MS = 3_000;
export const SYNC_PUSH_TIMEOUT_MS = 10_000;
export const FAIL_THRESHOLD = 2;

// 失败节点降频：连续失败 >= THROTTLE_FAIL_THRESHOLD 次后，
// 在 THROTTLE_PROBE_INTERVAL_MS 内只探测一次，避免反复打已知死节点
export const THROTTLE_FAIL_THRESHOLD = 5;
export const THROTTLE_PROBE_INTERVAL_MS = 30 * 60 * 1000;

export const EMBY_NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

// 一级功能命名空间：emby 功能挂在 /emby/<name>/... 与 /emby/<url> 下
export const EMBY_BASE_PATH = "/emby";
// 一级功能命名空间：通用图片代理 /img?url=...
export const IMG_BASE_PATH = "/img";
// 一级功能命名空间：豆瓣 addon 反代 /douban/...
export const DOUBAN_BASE_PATH = "/douban";
// 豆瓣 addon 原始后端（VPS 直连；fw-douban.laoz.org 是 nginx 前置，不依赖它）
export const DOUBAN_ORIGIN = "http://rn.127315.xyz:31001";
// 豆瓣 addon 默认 profile（fw 前置域名 + 默认 profile 路径）。fw 可达时
// /douban/* 直接 307 到 fw 域名（去掉 /douban 前缀），免 Worker 中转；
// 不可达时回退 DOUBAN_ORIGIN 反代。
export const DOUBAN_FW_ORIGIN = "https://fw-douban.laoz.org";
// fw 上 addon 实例的 profile 前缀（nginx 根路径是默认配置；用户配置的
// profile 是 /suyu，307 跳转必须带此前缀才命中用户配置的图源/行为）
export const DOUBAN_FW_PROFILE_PATH = "/suyu";
export const DOUBAN_FW_PROBE_PATH = DOUBAN_FW_PROFILE_PATH + "/manifest.json";
// fw 探活指数退避缓存：成功 15s；失败 5m → 10m → 30m → 1h → 2h → 4h → 8h
// → 16h → 24h（封顶），恢复后重新从 15s 开始
// 成功能级：15s
export const DOUBAN_FW_OK_TTL_MS = 15_000;
// 失败初始退避
export const DOUBAN_FW_FAIL_TTL_BASE_MS = 5 * 60 * 1000;
export const DOUBAN_FW_FAIL_TTL_MAX_MS = 24 * 60 * 60 * 1000;

// emby.node_id 哨兵值：Worker 本地代理（不 307，Worker 直接 fetch 后端回传）
export const LOCAL_NODE_ID = "local";

export const RESERVED_NAMES = new Set([
  "admin",
  "api",
  "health",
  "__health",
  "favicon.ico",
  "robots.txt",
  ".well-known",
  "_",
  "tmdb",
]);

export const ADMIN_COOKIE = "admin_token";
export const ADMIN_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

// Image proxy constants
export const IMAGE_CACHE_MAX_AGE = 7 * 24 * 60 * 60;
export const IMAGE_CACHE_SWR = 24 * 60 * 60;
export const STRIP_AUTH_PARAMS = ["api_key", "X-Emby-Token", "X-MediaBrowser-Token"];
export const FORWARD_REQ_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
]);
