/**
 * Where the e2e tests run (#536). By default, the local development stack: the dev server on
 * http://localhost:5173 (started by Playwright's own `webServer`), the shared "envelope" realm and
 * the database in `DATABASE_URL`. With `E2E_MANIFEST` set to a disposable environment's manifest
 * (`scripts/explore-env/`, `pnpm --filter @envelope/scripts explore:up`), its web app, realm and
 * database instead: the web app is already running, and the fixtures connect as the superuser of
 * the disposable environments' own PostgreSQL server (never the shared one), read from
 * `EXPLORE_DATABASE_URL` (CI) or from that server's 0600 `postgres.env`
 * (`~/.config/envelope-explore/`, or under `$XDG_CONFIG_HOME`). `KEYCLOAK_ADMIN_PASSWORD` is still
 * needed for the throwaway users.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

interface DisposableManifest {
  readonly database: string;
  readonly postgres: { readonly host: string; readonly port: number };
  readonly web: { readonly url: string };
  readonly keycloak: { readonly url: string; readonly realm: string };
}

function readManifest(file: string): DisposableManifest {
  const manifest = JSON.parse(readFileSync(file, "utf8")) as DisposableManifest;
  if (!/^envelope_explore_[0-9a-f]{8}$/.test(manifest.database) || !/^envelope-explore-[0-9a-f]{8}$/.test(manifest.keycloak.realm)) {
    throw new Error(`${file} is not a disposable environment's manifest`);
  }
  return manifest;
}

const manifestFile = process.env.E2E_MANIFEST;
const manifest = manifestFile ? readManifest(manifestFile) : undefined;

/** True when the tests run against a disposable environment rather than the local dev stack. */
export const usesDisposableEnvironment = manifest !== undefined;

export const WEB_URL = manifest?.web.url ?? "http://localhost:5173";
export const KEYCLOAK_URL = manifest?.keycloak.url ?? process.env.KEYCLOAK_URL ?? "http://127.0.0.1:8080";
export const REALM = manifest?.keycloak.realm ?? "envelope";

/** The disposable environments' superuser connection to `database`; refuses the shared server's port. */
function disposableServerUrl(environment: DisposableManifest): string {
  let url: URL;
  const override = process.env.EXPLORE_DATABASE_URL;
  if (override) {
    url = new URL(override);
  } else {
    const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "envelope-explore");
    const secrets = parseEnv(readFileSync(path.join(configDir, "postgres.env"), "utf8"));
    if (!secrets.POSTGRES_USER || !secrets.POSTGRES_PASSWORD) {
      throw new Error(`${configDir}/postgres.env is incomplete`);
    }
    url = new URL(`postgres://${environment.postgres.host}:${environment.postgres.port}/`);
    url.username = encodeURIComponent(secrets.POSTGRES_USER);
    url.password = encodeURIComponent(secrets.POSTGRES_PASSWORD);
  }
  if (url.port === "" || url.port === "5432") {
    throw new Error("Refusing to run e2e fixtures against PostgreSQL on port 5432: a disposable environment lives on its own server");
  }
  url.pathname = `/${environment.database}`;
  return url.toString();
}

/** The superuser connection for fixtures: the disposable environment's database when there is one. */
export function databaseUrl(): string {
  if (manifest) {
    return disposableServerUrl(manifest);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Set DATABASE_URL to run the e2e tests, e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope",
    );
  }
  return url;
}
