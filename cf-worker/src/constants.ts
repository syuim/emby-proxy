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
// 一级功能命名空间：通用 URL 代理 /url?url=...（与 /img 同构，非图片资源也可代理）
export const URL_BASE_PATH = "/url";
// 一级功能命名空间：豆瓣 addon 反代 /douban/...
export const DOUBAN_BASE_PATH = "/douban";
// 一级功能命名空间：豆瓣 API 反代 /doubanapi/...（简化版 Go 服务，仅 JSON catalog）
export const DOUBAN_API_BASE_PATH = "/doubanapi";
// 一级功能命名空间：TMDB 反代 /tmdb/...
export const TMDB_BASE_PATH = "/tmdb";
// 一级功能命名空间：Semby 聚合代理 /semby/...
export const SEMBY_BASE_PATH = "/semby";
// Semby 后端（RN 节点直连）
export const SEMBY_ORIGIN = "http://rn.127315.xyz:8096";
// 豆瓣 addon 原始后端（VPS 直连；fw-douban.laoz.org 是 nginx 前置，不依赖它）
export const DOUBAN_ORIGIN = "http://rn.127315.xyz:31001";
// 豆瓣 API 简化版后端（与 addon 同机不同容器）
export const DOUBAN_API_ORIGIN = "http://rn.127315.xyz:4000";

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
