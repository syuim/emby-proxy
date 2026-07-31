export const KV_KEY_NODES = "nodes";
export const KV_KEY_EMBYS = "embys";
export const KV_KEY_HEALTH = "health";

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
