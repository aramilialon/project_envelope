/**
 * Reads and validates the process environment once at startup, so a missing
 * or malformed variable is a clear error before the server opens a port,
 * not a confusing failure somewhere deep in the code later on.
 */

import { isIP } from "node:net";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

/** Selects the queue driver (design.md, "Queue module"); `postgres` (pg-boss) is the only one so far. */
export type QueueDriverName = "postgres";

const QUEUE_DRIVERS: readonly QueueDriverName[] = ["postgres"];

export interface Config {
  readonly host: string;
  readonly port: number;
  /** The API's own restricted connection (envelope_app, ADR 0006) — never the migration runner's. */
  readonly databaseUrl: string;
  readonly logLevel: LogLevel;
  readonly logPretty: boolean;
  readonly nodeEnv: string;
  readonly keycloakIssuer: string;
  readonly keycloakAudience: string;
  /** The web app's own origin (#48), the only one the API's CORS policy allows. */
  readonly webOrigin: string;
  /**
   * The reverse proxies whose `X-Forwarded-For` the API believes (#566): addresses or CIDR ranges,
   * never "any". Empty (the default) means the connection's own address is the client's address,
   * which is right when nothing fronts the API; behind Caddy on the same machine it is `127.0.0.1`.
   */
  readonly trustProxy: readonly string[];
  readonly rateLimit: RateLimitConfig;
}

/**
 * Request limits (#566, ADR 0017): one per client address, counted before authentication, and
 * three per verified user, counted after it. Each counts the requests of one window.
 */
export interface RateLimitConfig {
  readonly addressMax: number;
  readonly addressWindowMs: number;
  /** Every request of one user, whichever address it comes from. */
  readonly userMax: number;
  /** The window of the three per-user limits. */
  readonly userWindowMs: number;
  /** A user's writes (POST, PUT, PATCH, DELETE), counted in `userMax` too. */
  readonly userWriteMax: number;
  /** A user's file imports (`POST …/import`), counted in the two above too. */
  readonly userImportMax: number;
}

export interface QueueConfig {
  readonly driver: QueueDriverName;
  /** envelope_queue's own connection (#34): pg-boss manages its own schema, which needs DDL envelope_app deliberately cannot do. */
  readonly databaseUrl: string;
}

/** VAPID keys for the `web` push adapter (#39); `ios`/`android` are stubs, needing no config yet. */
export interface PushConfig {
  readonly vapidSubject: string;
  readonly vapidPublicKey: string;
  readonly vapidPrivateKey: string;
}

/**
 * The default request limits (#566, ADR 0017), the one place they are set; each can be overridden
 * by its environment variable. Sized from a measured session: an ordinary session in the web app
 * with a 35-category budget sent about 325 requests in 7 seconds, so a user gets 1200 a minute,
 * room for a few such bursts in one minute. The per-address limit is twice that, above the
 * per-user one, because one address can carry several members (every device behind one NAT, or
 * Caddy's own address when TRUST_PROXY is not set) and it runs first: below the per-user limit,
 * it would refuse a member the per-user limit allows.
 */
export const RATE_LIMIT_DEFAULTS = {
  addressMax: 2400,
  windowSeconds: 60,
  userMax: 1200,
  userWriteMax: 120,
  userImportMax: 10,
} as const;

const LOG_LEVELS: readonly LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST || "127.0.0.1",
    port: parsePort(env, "PORT", 3000),
    databaseUrl: requireEnv(env, "APP_DATABASE_URL"),
    logLevel: parseLogLevel(env, "LOG_LEVEL", "info"),
    logPretty: parseBoolean(env, "LOG_PRETTY", false),
    nodeEnv: env.NODE_ENV || "development",
    keycloakIssuer: requireEnv(env, "KEYCLOAK_ISSUER"),
    keycloakAudience: requireEnv(env, "KEYCLOAK_AUDIENCE"),
    webOrigin: env.WEB_ORIGIN || "http://localhost:5173",
    trustProxy: parseTrustProxy(env, "TRUST_PROXY"),
    rateLimit: {
      addressMax: parsePositiveInteger(env, "RATE_LIMIT_IP_MAX", RATE_LIMIT_DEFAULTS.addressMax),
      addressWindowMs: parsePositiveInteger(env, "RATE_LIMIT_IP_WINDOW_SECONDS", RATE_LIMIT_DEFAULTS.windowSeconds) * 1000,
      userMax: parsePositiveInteger(env, "RATE_LIMIT_USER_MAX", RATE_LIMIT_DEFAULTS.userMax),
      userWindowMs: parsePositiveInteger(env, "RATE_LIMIT_USER_WINDOW_SECONDS", RATE_LIMIT_DEFAULTS.windowSeconds) * 1000,
      userWriteMax: parsePositiveInteger(env, "RATE_LIMIT_USER_WRITE_MAX", RATE_LIMIT_DEFAULTS.userWriteMax),
      userImportMax: parsePositiveInteger(env, "RATE_LIMIT_USER_IMPORT_MAX", RATE_LIMIT_DEFAULTS.userImportMax),
    },
  };
}

/**
 * The queue module (#34) needs its own connection (envelope_queue, not
 * envelope_app), the same way the migration runner does below — loaded
 * separately so `loadConfig` and its many existing callers stay untouched.
 */
export function loadQueueConfig(env: NodeJS.ProcessEnv = process.env): QueueConfig {
  return {
    driver: parseQueueDriver(env, "QUEUE_DRIVER", "postgres"),
    databaseUrl: requireEnv(env, "QUEUE_DATABASE_URL"),
  };
}

/**
 * The push module (#39) needs VAPID credentials, loaded separately from `Config` the same way
 * `loadQueueConfig` is, so `loadConfig`'s many existing callers stay untouched.
 */
export function loadPushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig {
  return {
    vapidSubject: requireEnv(env, "VAPID_SUBJECT"),
    vapidPublicKey: requireEnv(env, "VAPID_PUBLIC_KEY"),
    vapidPrivateKey: requireEnv(env, "VAPID_PRIVATE_KEY"),
  };
}

function parseQueueDriver(env: NodeJS.ProcessEnv, name: string, defaultValue: QueueDriverName): QueueDriverName {
  const value = env[name] ?? defaultValue;
  if (!QUEUE_DRIVERS.includes(value as QueueDriverName)) {
    throw new Error(`${name} must be one of ${QUEUE_DRIVERS.join(", ")}, got "${value}"`);
  }
  return value as QueueDriverName;
}

/**
 * The migration runner needs its own connection, with the privileges to run
 * DDL (create tables, grant to envelope_app) that the restricted app
 * connection (APP_DATABASE_URL, above) deliberately does not have. Loading
 * the full Config would also make it demand Keycloak settings it has no use
 * for.
 */
export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return requireEnv(env, "DATABASE_URL");
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePort(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const value = env[name];
  if (value === undefined) {
    return defaultValue;
  }
  // Digits only: Number() alone would turn "", " ", "0x10" or "1e3" into a port.
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw new Error(`${name} must be an integer between 0 and 65535, got "${value}"`);
  }
  // 0 asks the operating system for any free port (the smoke tests use it, #519); a production
  // server needs a port people can reach, so there it is a mistake, not a choice.
  if (port === 0 && env.NODE_ENV === "production") {
    throw new Error(`${name} cannot be 0 when NODE_ENV is production`);
  }
  return port;
}

function parsePositiveInteger(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const value = env[name];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

/**
 * A comma-separated list of addresses or CIDR ranges (`127.0.0.1`, `10.0.0.0/24`, `::1`). Anything
 * else is refused, "true" and "*" included: believing `X-Forwarded-For` from every address would
 * let any client choose the address its requests are counted under.
 */
function parseTrustProxy(env: NodeJS.ProcessEnv, name: string): readonly string[] {
  const value = env[name]?.trim();
  if (!value) {
    return [];
  }
  return value.split(",").map((entry) => {
    const trimmed = entry.trim();
    const [address, prefix, ...rest] = trimmed.split("/");
    const family = isIP(address ?? "");
    const maxPrefix = family === 6 ? 128 : 32;
    const validPrefix = prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= maxPrefix);
    if (family === 0 || !validPrefix || rest.length > 0) {
      throw new Error(`${name} must be a comma-separated list of IP addresses or CIDR ranges, got "${trimmed}"`);
    }
    return trimmed;
  });
}

function parseLogLevel(env: NodeJS.ProcessEnv, name: string, defaultValue: LogLevel): LogLevel {
  const value = env[name] ?? defaultValue;
  if (!LOG_LEVELS.includes(value as LogLevel)) {
    throw new Error(`${name} must be one of ${LOG_LEVELS.join(", ")}, got "${value}"`);
  }
  return value as LogLevel;
}

function parseBoolean(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean): boolean {
  const value = env[name];
  if (value === undefined) {
    return defaultValue;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new Error(`${name} must be "true"/"false" or "1"/"0", got "${value}"`);
}
