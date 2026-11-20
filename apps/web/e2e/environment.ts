/**
 * Where the e2e tests run (#536). By default, the local development stack: the dev server on
 * http://localhost:5173 (started by Playwright's own `webServer`), the shared "envelope" realm and
 * the database in `DATABASE_URL`. With `E2E_MANIFEST` set to a disposable environment's manifest
 * (`scripts/explore-env/`, `pnpm --filter @envelope/scripts explore:up`), its web app, realm and
 * database instead: the web app is already running, and the fixtures still connect with
 * `DATABASE_URL`'s superuser and `KEYCLOAK_ADMIN_PASSWORD`, but to that run's database and realm.
 */
import { readFileSync } from "node:fs";

interface DisposableManifest {
  readonly database: string;
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

/** The superuser connection for fixtures, pointed at the disposable environment's database when there is one. */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Set DATABASE_URL to run the e2e tests, e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope",
    );
  }
  if (!manifest) {
    return url;
  }
  const parsed = new URL(url);
  parsed.pathname = `/${manifest.database}`;
  return parsed.toString();
}
