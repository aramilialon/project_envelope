/**
 * A disposable environment for exploratory and e2e runs (#536): its own database, its own
 * Keycloak realm with persona users, its own API and its own built web app, all on 127.0.0.1,
 * described by one manifest. See scripts/README.md ("Disposable environments").
 *
 *   node explore-env/cli.ts up [--root <dir>]
 *   node explore-env/cli.ts down <run | manifest.json> [--root <dir>]
 *   node explore-env/cli.ts sweep [--root <dir>] [--older-than-hours <n>]
 *
 * Needs DATABASE_URL (a superuser connection, used only by this process) and
 * KEYCLOAK_ADMIN_PASSWORD; KEYCLOAK_URL defaults to http://127.0.0.1:8080. Prints no secret: the
 * personas' passwords are only in the manifest, the database roles' passwords only in the API
 * process's environment.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Api } from "../lib/api.ts";
import { assertSafeToRun, requireEnv } from "../lib/env.ts";
import { API_CLIENT_ID, KeycloakAdmin, personaToken, WEB_CLIENT_ID } from "./keycloak.ts";
import {
  createRunDir,
  defaultRoot,
  type Manifest,
  MANIFEST_FILE,
  type ManifestUser,
  type ManifestWorkspace,
  type Persona,
  readManifest,
  type Role,
  writeManifest,
} from "./manifest.ts";
import {
  assertEnvTargetsRun,
  assertRunId,
  databaseName,
  newRunId,
  REALM_PREFIX,
  realmName,
  realmOfIssuer,
  runOf,
} from "./names.ts";
import { addMembership, connectionTo, createDatabase, dropDatabase, ensureRoleLogin, listExploreDatabases, migrate, rolePassword } from "./postgres.ts";
import { findRunProcesses, runToLog, startDetached, stopProcess, waitForListening } from "./processes.ts";
import { generateVapidKeys } from "./vapid.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const API_DIR = path.join(REPO_ROOT, "apps/api");
const WEB_DIR = path.join(REPO_ROOT, "apps/web");
const STATIC_SERVER_TS = fileURLToPath(new URL("./static-server.ts", import.meta.url));

interface PersonaSpec {
  readonly persona: Persona;
  readonly workspace: string;
  readonly taxCountry: string | null;
  readonly firstName: string;
}

/** Household budgets through the web app; investor and mixed also use the portfolio API, so their workspaces are Italian for tax regimes (#508). */
const PERSONAS: readonly PersonaSpec[] = [
  { persona: "household", workspace: "Household", taxCountry: null, firstName: "Household" },
  { persona: "investor", workspace: "Investor", taxCountry: "IT", firstName: "Investor" },
  { persona: "mixed", workspace: "Mixed household", taxCountry: "IT", firstName: "Mixed" },
];

const MEMBER_ROLES: readonly { suffix: string; role: Role }[] = [
  { suffix: "", role: "owner" },
  { suffix: "-editor", role: "editor" },
  { suffix: "-reader", role: "read_only" },
];

function log(line: string): void {
  console.log(line);
}

interface Settings {
  readonly superuserUrl: string;
  readonly keycloak: KeycloakAdmin;
}

function settings(): Settings {
  const superuserUrl = requireEnv("DATABASE_URL");
  const keycloakUrl = (process.env.KEYCLOAK_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
  assertSafeToRun({ DATABASE_URL: superuserUrl, KEYCLOAK_URL: keycloakUrl });
  const issuer = process.env.KEYCLOAK_ISSUER;
  if (issuer && !realmOfIssuer(issuer).startsWith(REALM_PREFIX)) {
    throw new Error(
      `Refusing to run with KEYCLOAK_ISSUER pointing at realm "${realmOfIssuer(issuer)}": a disposable environment never uses a shared realm. Unset it.`,
    );
  }
  return { superuserUrl, keycloak: new KeycloakAdmin(keycloakUrl, requireEnv("KEYCLOAK_ADMIN_PASSWORD")) };
}

function marker(run: string): string {
  return realmName(run);
}

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
}

async function up(root: string): Promise<void> {
  const { superuserUrl, keycloak } = settings();
  const run = newRunId();
  const database = databaseName(run);
  const realm = realmName(run);
  const createdAt = new Date();
  const runDir = await createRunDir(root, run);
  const logs = { api: path.join(runDir, "api.log"), web: path.join(runDir, "web.log"), build: path.join(runDir, "build.log") };
  const processes: { api?: number; web?: number } = {};
  log(`== Run ${run} (${runDir})`);

  try {
    log(`== Creating and migrating database ${database}`);
    await createDatabase(superuserUrl, database, createdAt);
    const databaseUrl = connectionTo(superuserUrl, database);
    await migrate(databaseUrl, (line) => log(`   ${line}`));
    const appPassword = rolePassword("envelope_app", "APP_DATABASE_URL");
    const queuePassword = rolePassword("envelope_queue", "QUEUE_DATABASE_URL");
    await ensureRoleLogin(superuserUrl, database, "envelope_app", appPassword, "APP_DATABASE_URL");
    await ensureRoleLogin(superuserUrl, database, "envelope_queue", queuePassword, "QUEUE_DATABASE_URL");

    log("== Starting the web server");
    const webRoot = path.join(runDir, "web");
    processes.web = startDetached(process.execPath, [STATIC_SERVER_TS, webRoot, "0", marker(run)], {
      cwd: runDir,
      env: baseEnv(),
      logFile: logs.web,
    });
    const webUrl = await waitForListening(processes.web, logs.web);

    log(`== Creating realm ${realm}`);
    await keycloak.createRealm(realm, createdAt);
    await keycloak.bootstrap(realm, webUrl, (line) => log(`   ${line}`));
    await keycloak.createApiClient(realm);
    const issuer = `${keycloak.url}/realms/${realm}`;

    log("== Starting the API");
    const vapid = generateVapidKeys();
    const apiEnv: Record<string, string> = {
      ...baseEnv(),
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: "0",
      LOG_LEVEL: "info",
      LOG_PRETTY: "false",
      APP_DATABASE_URL: connectionTo(superuserUrl, database, { user: "envelope_app", password: appPassword }),
      QUEUE_DRIVER: "postgres",
      QUEUE_DATABASE_URL: connectionTo(superuserUrl, database, { user: "envelope_queue", password: queuePassword }),
      VAPID_SUBJECT: "mailto:explore@example.invalid",
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      KEYCLOAK_ISSUER: issuer,
      KEYCLOAK_AUDIENCE: WEB_CLIENT_ID,
      WEB_ORIGIN: webUrl,
    };
    assertEnvTargetsRun(apiEnv, run);
    processes.api = startDetached(process.execPath, [path.join(API_DIR, "src/main.ts"), marker(run)], {
      cwd: API_DIR,
      env: apiEnv,
      logFile: logs.api,
    });
    const apiUrl = await waitForListening(processes.api, logs.api);

    log("== Building the web app");
    const buildEnv: Record<string, string> = {
      ...baseEnv(),
      VITE_API_URL: apiUrl,
      VITE_KEYCLOAK_ISSUER: issuer,
      VITE_KEYCLOAK_CLIENT_ID: WEB_CLIENT_ID,
    };
    assertEnvTargetsRun(buildEnv, run);
    await runToLog("pnpm", ["exec", "vite", "build", "--outDir", webRoot, "--emptyOutDir"], { cwd: WEB_DIR, env: buildEnv, logFile: logs.build });

    const draft = (workspaces: ManifestWorkspace[], users: ManifestUser[]): Manifest => ({
      version: 1,
      run,
      createdAt: createdAt.toISOString(),
      runDir,
      database,
      web: { url: webUrl },
      api: { url: apiUrl },
      keycloak: {
        url: keycloak.url,
        realm,
        issuer,
        webClientId: WEB_CLIENT_ID,
        apiClientId: API_CLIENT_ID,
        tokenEndpoint: `${issuer}/protocol/openid-connect/token`,
      },
      workspaces,
      users,
      processes: { ...processes },
      logs,
    });
    // Written before the personas exist, so `down` can find the processes if what follows fails.
    await writeManifest(draft([], []));

    log("== Creating personas and their workspaces");
    const workspaces: ManifestWorkspace[] = [];
    const users: ManifestUser[] = [];
    for (const spec of PERSONAS) {
      const members: { username: string; password: string; role: Role }[] = [];
      for (const { suffix, role } of MEMBER_ROLES) {
        const username = `${spec.persona}${suffix}`;
        const password = randomBytes(18).toString("base64url");
        await keycloak.createUser(realm, username, password, spec.firstName);
        members.push({ username, password, role });
      }
      const [owner, ...others] = members;
      const ownerApi = new Api(apiUrl, await personaToken(keycloak.url, realm, owner!.username, owner!.password));
      const workspace = await ownerApi.post<{ id: string; name: string }>("/workspaces", {
        name: spec.workspace,
        baseCurrency: "EUR",
        timeZone: "Europe/Rome",
      });
      if (spec.taxCountry) {
        await ownerApi.patch(`/workspaces/${workspace.id}`, { taxCountry: spec.taxCountry });
      }
      workspaces.push({ persona: spec.persona, id: workspace.id, name: workspace.name, taxCountry: spec.taxCountry });
      users.push({ persona: spec.persona, username: owner!.username, password: owner!.password, role: owner!.role, workspaceId: workspace.id });
      for (const member of others) {
        // The first authenticated request creates the user's local row (the user-mapper preHandler).
        const memberApi = new Api(apiUrl, await personaToken(keycloak.url, realm, member.username, member.password));
        const { userId } = await memberApi.get<{ userId: string }>("/me");
        await addMembership(databaseUrl, userId, workspace.id, member.role);
        const { workspaces: visible } = await memberApi.get<{ workspaces: { id: string }[] }>("/me/workspaces");
        if (!visible.some((w) => w.id === workspace.id)) {
          throw new Error(`${member.username} does not see workspace ${workspace.id} after joining it`);
        }
        users.push({ persona: spec.persona, username: member.username, password: member.password, role: member.role, workspaceId: workspace.id });
      }
    }

    const manifestFile = await writeManifest(draft(workspaces, users));
    log("== Ready");
    log(`   web:      ${webUrl}`);
    log(`   api:      ${apiUrl}`);
    log(`   realm:    ${realm}`);
    log(`   users:    ${users.map((u) => u.username).join(", ")} (passwords in the manifest)`);
    log(`   manifest: ${manifestFile}`);
    log(`   down:     pnpm --filter @envelope/scripts explore:down ${root === defaultRoot() ? run : manifestFile}`);
  } catch (error) {
    log(`== Failed; removing run ${run}`);
    await teardown(run, { superuserUrl, keycloak }, processes, runDir, false).catch((cleanupError: unknown) => {
      log(`   cleanup failed too: ${String(cleanupError)}`);
    });
    log(`   logs kept in ${runDir}`);
    throw error;
  }
}

async function teardown(
  run: string,
  { superuserUrl, keycloak }: Settings,
  processes: { api?: number; web?: number },
  runDir: string | undefined,
  removeRunDir: boolean,
): Promise<void> {
  assertRunId(run);
  for (const [name, pid] of Object.entries(processes)) {
    if (pid !== undefined) {
      log(`   ${name} (pid ${pid}): ${await stopProcess(pid, marker(run))}`);
    }
  }
  // Any process of this run the manifest did not list (a lost manifest, an `up` killed midway).
  for (const pid of await findRunProcesses(marker(run))) {
    log(`   unlisted process (pid ${pid}): ${await stopProcess(pid, marker(run))}`);
  }
  const database = databaseName(run);
  const realm = realmName(run);
  log(`   database ${database}: ${(await dropDatabase(superuserUrl, database)) ? "dropped" : "already gone"}`);
  log(`   realm ${realm}: ${(await keycloak.deleteRealm(realm)) ? "deleted" : "already gone"}`);
  if (removeRunDir && runDir && path.basename(runDir) === run && existsSync(runDir)) {
    await rm(runDir, { recursive: true, force: true });
    log(`   run directory ${runDir}: removed`);
  }
}

async function down(target: string, root: string): Promise<void> {
  const config = settings();
  let manifest: Manifest | undefined;
  let run: string;
  if (target.endsWith(".json") || target.includes(path.sep)) {
    if (!existsSync(target)) {
      throw new Error(`No manifest at ${target}`);
    }
    manifest = await readManifest(target);
    run = manifest.run;
  } else {
    run = runOf(target) ?? target;
    assertRunId(run);
    const file = path.join(root, run, MANIFEST_FILE);
    if (existsSync(file)) {
      manifest = await readManifest(file);
    }
  }
  log(`== Removing run ${run}`);
  await teardown(run, config, manifest?.processes ?? {}, manifest?.runDir ?? path.join(root, run), true);
}

async function sweep(root: string, olderThanHours: number): Promise<void> {
  const config = settings();
  const cutoff = Date.now() - olderThanHours * 3_600_000;
  const isOld = (createdAt: Date | undefined): boolean => createdAt !== undefined && createdAt.getTime() < cutoff;
  log(`== Sweeping environments created more than ${olderThanHours} h ago`);

  const removed = new Set<string>();
  const entries = existsSync(root) ? await readdir(root) : [];
  for (const entry of entries) {
    const file = path.join(root, entry, MANIFEST_FILE);
    if (!existsSync(file)) {
      continue;
    }
    const manifest = await readManifest(file).catch(() => undefined);
    if (manifest && isOld(new Date(manifest.createdAt))) {
      log(`== Run ${manifest.run} (manifest)`);
      await teardown(manifest.run, config, manifest.processes, manifest.runDir, true);
      removed.add(manifest.run);
    }
  }

  // Leftovers with no manifest (an `up` killed midway, a deleted run directory): a run whose
  // database or realm is old enough is removed whole, its processes included.
  const leftovers = new Map<string, string>();
  const consider = (kind: string, name: string, createdAt: Date | undefined): void => {
    const run = runOf(name);
    if (run === undefined || removed.has(run)) {
      return;
    }
    if (createdAt === undefined) {
      log(`   ${kind} ${name}: no creation time recorded, left alone`);
    } else if (isOld(createdAt)) {
      leftovers.set(run, name);
    }
  };
  for (const db of await listExploreDatabases(config.superuserUrl)) {
    consider("database", db.name, db.createdAt);
  }
  for (const realm of await config.keycloak.listExploreRealms()) {
    consider("realm", realm.name, realm.createdAt);
  }
  for (const [run, name] of leftovers) {
    log(`== Run ${run} (from ${name})`);
    await teardown(run, config, {}, path.join(root, run), true);
  }
  log("== Sweep done");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} needs a value`);
  }
  args.splice(index, 2);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const root = path.resolve(option(args, "--root") ?? defaultRoot());
  const hours = option(args, "--older-than-hours");
  const [command, target] = args;
  switch (command) {
    case "up":
      await up(root);
      return;
    case "down":
      if (!target) {
        throw new Error("Usage: down <run | manifest.json> [--root <dir>]");
      }
      await down(target, root);
      return;
    case "sweep": {
      const olderThanHours = hours === undefined ? 24 : Number(hours);
      if (!Number.isFinite(olderThanHours) || olderThanHours < 0) {
        throw new Error("--older-than-hours must be a number of hours, 0 or more");
      }
      await sweep(root, olderThanHours);
      return;
    }
    default:
      throw new Error("Usage: cli.ts up | down <run | manifest.json> | sweep [--root <dir>] [--older-than-hours <n>]");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
