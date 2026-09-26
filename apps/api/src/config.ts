/**
 * Reads and validates the process environment once at startup, so a missing
 * or malformed variable is a clear error before the server opens a port,
 * not a confusing failure somewhere deep in the code later on.
 */

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

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
}

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
  };
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
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got "${value}"`);
  }
  return port;
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
