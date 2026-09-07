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
// 一级功能命名空间：通用 URL 代理 /url?url=...（任意 http(s) 资源，图片/API 均可）
export const URL_BASE_PATH = "/url";
// 一级功能命名空间：豆瓣 API 别名入口 /doubanapi/...（内部重写为名称访问，见 router.ts）
export const DOUBAN_API_BASE_PATH = "/doubanapi";
// /doubanapi 别名对应的 emby 记录名（D1 embys 表：绑代理组后按入口 ASN 走节点分发）
export const DOUBAN_API_EMBY_NAME = "douban";
// 一级功能命名空间：TMDB 反代 /tmdb/...
export const TMDB_BASE_PATH = "/tmdb";

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

// /url 通用代理图片缓存时长
export const IMAGE_CACHE_MAX_AGE = 7 * 24 * 60 * 60;
