/**
 * The run manifest (#536): everything an explorer or an e2e run needs to use one disposable
 * environment, and everything `down` needs to remove it. It holds the personas' own passwords
 * (throwaway, valid only in this run's realm) but never a superuser connection string, a
 * database role's password or a Keycloak admin credential. Written with mode 0600 in a run
 * directory of mode 0700.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertExploreDatabase, assertExploreRealm, assertRunId, databaseName, realmName } from "./names.ts";

export const MANIFEST_FILE = "manifest.json";

export type Persona = "household" | "investor" | "mixed";
export type Role = "owner" | "editor" | "read_only";

export interface ManifestUser {
  readonly persona: Persona;
  readonly username: string;
  readonly password: string;
  readonly role: Role;
  readonly workspaceId: string;
}

export interface ManifestWorkspace {
  readonly persona: Persona;
  readonly id: string;
  readonly name: string;
  readonly taxCountry: string | null;
}

export interface Manifest {
  readonly version: 1;
  readonly run: string;
  readonly createdAt: string;
  readonly runDir: string;
  readonly database: string;
  readonly web: { readonly url: string };
  readonly api: { readonly url: string };
  readonly keycloak: {
    readonly url: string;
    readonly realm: string;
    readonly issuer: string;
    /** The web app's own client: public, Authorization Code + PKCE only. */
    readonly webClientId: string;
    /** A public client of this realm only, with the password grant, for calling the API directly. */
    readonly apiClientId: string;
    readonly tokenEndpoint: string;
  };
  readonly workspaces: readonly ManifestWorkspace[];
  readonly users: readonly ManifestUser[];
  readonly processes: { readonly api?: number; readonly web?: number };
  readonly logs: { readonly api: string; readonly web: string; readonly build: string };
}

/** `$TMPDIR/envelope-explore`, unless the caller names another root. */
export function defaultRoot(): string {
  return path.join(tmpdir(), "envelope-explore");
}

export async function createRunDir(root: string, run: string): Promise<string> {
  assertRunId(run);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const runDir = path.join(root, run);
  await mkdir(runDir, { mode: 0o700 });
  return runDir;
}

export async function writeManifest(manifest: Manifest): Promise<string> {
  const file = path.join(manifest.runDir, MANIFEST_FILE);
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

export async function readManifest(file: string): Promise<Manifest> {
  const manifest = JSON.parse(await readFile(file, "utf8")) as Manifest;
  assertRunId(manifest.run);
  assertExploreDatabase(manifest.database);
  assertExploreRealm(manifest.keycloak.realm);
  if (manifest.database !== databaseName(manifest.run) || manifest.keycloak.realm !== realmName(manifest.run)) {
    throw new Error(`${file}: its database and realm do not belong to run ${manifest.run}`);
  }
  return manifest;
}
