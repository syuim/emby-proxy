export const KV_KEY_NODES = "nodes";
export const KV_KEY_EMBYS = "embys";
export const KV_KEY_HEALTH = "health";

export const SYNC_PATH = "/admin/sync";
export const STATUS_PATH = "/admin/status";
export const NODE_HEALTH_PATH = "/__health";

export const HEALTH_PROBE_TIMEOUT_MS = 3_000;
export const SYNC_PUSH_TIMEOUT_MS = 10_000;
export const FAIL_THRESHOLD = 2;

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
]);

export const ADMIN_COOKIE = "admin_token";
export const ADMIN_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
