/**
 * A disposable environment for exploratory and e2e runs (#536): its own database (on a
 * PostgreSQL server of its own, `instance.ts`), its own Keycloak realm with persona users, its
 * own API and its own built web app, all on 127.0.0.1, described by one manifest. See
 * scripts/README.md ("Disposable environments").
 *
 *   node explore-env/cli.ts up [--root <dir>]
 *   node explore-env/cli.ts down <run | manifest.json> [--root <dir>]
 *   node explore-env/cli.ts sweep [--root <dir>] [--older-than-hours <n>]
 *
 * Needs KEYCLOAK_ADMIN_PASSWORD; KEYCLOAK_URL defaults to http://127.0.0.1:8080. DATABASE_URL is
 * not used: the database server is the managed `envelope-explore-postgres` container, or
 * EXPLORE_DATABASE_URL in CI. Prints no secret: the personas' passwords are only in the manifest,
 * the database roles' passwords only in the API process's environment and the instance's 0600
 * configuration files.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Api } from "../lib/api.ts";
import { assertSafeToRun, requireEnv } from "../lib/env.ts";
import { instanceUrl } from "./instance.ts";
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
import { assertEnvTargetsRun, assertRunId, databaseName, newRunId, REALM_PREFIX, realmName, realmOfIssuer, runOf } from "./names.ts";
import {
  addMembership,
  closeSharedAccess,
  connectionTo,
  createDatabase,
  createRunRoles,
  dropDatabase,
  dropRunRoles,
  listExploreDatabases,
  listRunsWithRoles,
  migrate,
} from "./postgres.ts";
import { assertPrivate } from "./private-dir.ts";
import { findRunProcesses, runToLog, startDetached, stopProcess, waitForListening } from "./processes.ts";
import { generateVapidKeys } from "./vapid.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const API_DIR = path.join(REPO_ROOT, "apps/api");
const WEB_DIR = path.join(REPO_ROOT, "apps/web");
const STATIC_SERVER_TS = fileURLToPath(new URL("./static-server.ts", import.meta.url));
const RUN_DIR_NAME = /^[0-9a-f]{8}$/;

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
  /** The disposable environments' server; undefined when there is none yet (`down`/`sweep` only). */
  readonly superuserUrl: string | undefined;
  readonly keycloak: KeycloakAdmin;
}

async function settings(mode: "create" | "existing"): Promise<Settings> {
  const keycloakUrl = (process.env.KEYCLOAK_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
  assertSafeToRun({ KEYCLOAK_URL: keycloakUrl, ...(process.env.EXPLORE_DATABASE_URL ? { EXPLORE_DATABASE_URL: process.env.EXPLORE_DATABASE_URL } : {}) });
  const issuer = process.env.KEYCLOAK_ISSUER;
  if (issuer && !realmOfIssuer(issuer).startsWith(REALM_PREFIX)) {
    throw new Error(
      `Refusing to run with KEYCLOAK_ISSUER pointing at realm "${realmOfIssuer(issuer)}": a disposable environment never uses a shared realm. Unset it.`,
    );
  }
  const keycloak = new KeycloakAdmin(keycloakUrl, requireEnv("KEYCLOAK_ADMIN_PASSWORD"));
  return { superuserUrl: await instanceUrl(mode), keycloak };
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

/**
 * Ctrl-C or SIGTERM during `up` aborts the step in progress (a build or migration child is
 * stopped), then removes everything the run created and exits 130 or 143. A second signal exits
 * at once.
 */
function interruptible(): { signal: AbortSignal; exitCode: () => number | undefined; release: () => void } {
  const controller = new AbortController();
  let code: number | undefined;
  const handler = (sig: NodeJS.Signals): void => {
    if (controller.signal.aborted) {
      process.exit(code ?? 1);
    }
    code = sig === "SIGINT" ? 130 : 143;
    log(`== ${sig} received: stopping`);
    controller.abort(new Error(`Interrupted by ${sig}`));
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return {
    signal: controller.signal,
    exitCode: () => code,
    release: () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    },
  };
}

async function up(root: string): Promise<void> {
  const interrupt = interruptible();
  const { signal } = interrupt;
  const config = await settings("create");
  const { keycloak } = config;
  const superuserUrl = config.superuserUrl!;
  signal.throwIfAborted();
  const run = newRunId();
  const database = databaseName(run);
  const realm = realmName(run);
  const createdAt = new Date();
  const runDir = await createRunDir(root, run);
  const logs = { api: path.join(runDir, "api.log"), web: path.join(runDir, "web.log"), build: path.join(runDir, "build.log") };
  const processes: { api?: number; web?: number } = {};
  const server = new URL(superuserUrl);
  log(`== Run ${run} (${runDir})`);

  try {
    log(`== Creating and migrating database ${database} (PostgreSQL on ${server.hostname}:${server.port})`);
    await createDatabase(superuserUrl, database, createdAt);
    const databaseUrl = connectionTo(superuserUrl, database);
    await migrate(databaseUrl, (line) => log(`   ${line}`), signal);
    // The run's own login roles, with passwords that exist only in its API's environment.
    const rolePasswords = { app: randomBytes(24).toString("base64url"), queue: randomBytes(24).toString("base64url") };
    const roles = await createRunRoles(superuserUrl, database, run, rolePasswords);
    await closeSharedAccess(superuserUrl);
    signal.throwIfAborted();

    log("== Starting the web server");
    const webRoot = path.join(runDir, "web");
    processes.web = startDetached(process.execPath, [STATIC_SERVER_TS, webRoot, "0", marker(run)], {
      cwd: runDir,
      env: baseEnv(),
      logFile: logs.web,
    });
    const webUrl = await waitForListening(processes.web, logs.web, signal);

    log(`== Creating realm ${realm}`);
    await keycloak.createRealm(realm, createdAt);
    await keycloak.bootstrap(realm, webUrl, (line) => log(`   ${line}`));
    await keycloak.createApiClient(realm);
    const issuer = `${keycloak.url}/realms/${realm}`;
    signal.throwIfAborted();

    log("== Starting the API");
    const vapid = generateVapidKeys();
    const apiEnv: Record<string, string> = {
      ...baseEnv(),
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: "0",
      LOG_LEVEL: "info",
      LOG_PRETTY: "false",
      APP_DATABASE_URL: connectionTo(superuserUrl, database, { user: roles.app, password: rolePasswords.app }),
      QUEUE_DRIVER: "postgres",
      QUEUE_DATABASE_URL: connectionTo(superuserUrl, database, { user: roles.queue, password: rolePasswords.queue }),
      VAPID_SUBJECT: "mailto:explore@example.invalid",
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      KEYCLOAK_ISSUER: issuer,
      KEYCLOAK_AUDIENCE: WEB_CLIENT_ID,
      WEB_ORIGIN: webUrl,
      // Every client of a disposable environment (the e2e suite's parallel workers, several
      // explorers at once) connects from 127.0.0.1, so they all share one per-address count (#566):
      // that limit is raised here, while the per-user limits keep their defaults.
      RATE_LIMIT_IP_MAX: "100000",
      // A disposable environment makes no outbound request (#85): the e2e suite runs on it, and
      // tests never reach the network. Rates are loaded with `fx-rates:import` when a run needs them.
      MARKET_DATA_FETCH_ENABLED: "false",
    };
    assertEnvTargetsRun(apiEnv, run);
    processes.api = startDetached(process.execPath, [path.join(API_DIR, "src/main.ts"), marker(run)], {
      cwd: API_DIR,
      env: apiEnv,
      logFile: logs.api,
    });
    const apiUrl = await waitForListening(processes.api, logs.api, signal);

    const draft = (workspaces: ManifestWorkspace[], users: ManifestUser[]): Manifest => ({
      version: 1,
      run,
      createdAt: createdAt.toISOString(),
      runDir,
      database,
      postgres: { host: server.hostname, port: Number(server.port) },
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
    // Written before the build and the personas, so `down` can find the processes if what follows fails.
    await writeManifest(draft([], []));

    log("== Building the web app");
    const buildEnv: Record<string, string> = {
      ...baseEnv(),
      VITE_API_URL: apiUrl,
      VITE_KEYCLOAK_ISSUER: issuer,
      VITE_KEYCLOAK_CLIENT_ID: WEB_CLIENT_ID,
    };
    assertEnvTargetsRun(buildEnv, run);
    await runToLog("pnpm", ["exec", "vite", "build", "--outDir", webRoot, "--emptyOutDir"], { cwd: WEB_DIR, env: buildEnv, logFile: logs.build, signal });

    log("== Creating personas and their workspaces");
    const workspaces: ManifestWorkspace[] = [];
    const users: ManifestUser[] = [];
    for (const spec of PERSONAS) {
      signal.throwIfAborted();
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
    signal.throwIfAborted();

    const manifestFile = await writeManifest(draft(workspaces, users));
    interrupt.release();
    log("== Ready");
    log(`   web:      ${webUrl}`);
    log(`   api:      ${apiUrl}`);
    log(`   realm:    ${realm}`);
    log(`   users:    ${users.map((u) => u.username).join(", ")} (passwords in the manifest)`);
    log(`   manifest: ${manifestFile}`);
    log(`   down:     pnpm --filter @envelope/scripts explore:down ${root === defaultRoot() ? run : manifestFile}`);
  } catch (error) {
    const interrupted = interrupt.exitCode();
    log(interrupted === undefined ? `== Failed; removing run ${run}` : `== Interrupted; removing run ${run}`);
    // An interrupted run leaves nothing behind; a failed one keeps its logs (sweep removes the directory later).
    await teardown(run, config, processes, runDir, interrupted !== undefined).catch((cleanupError: unknown) => {
      log(`   cleanup failed too: ${String(cleanupError)}`);
    });
    interrupt.release();
    if (interrupted !== undefined) {
      process.exit(interrupted);
    }
    log(`   logs kept in ${runDir}`);
    throw error;
  }
}

/**
 * Removes one run: its processes (those `processes` lists and any other found by their command
 * line), its database, its realm and, with `removeRunDir`, `runDir` — only when that directory is
 * named after the run.
 */
async function teardown(
  run: string,
  { superuserUrl, keycloak }: Settings,
  processes: { api?: number; web?: number },
  runDir: string | undefined,
  removeRunDir: boolean,
): Promise<void> {
  assertRunId(run);
  for (const [name, pid] of Object.entries(processes)) {
    if (typeof pid === "number") {
      log(`   ${name} (pid ${pid}): ${await stopProcess(pid, marker(run))}`);
    }
  }
  // Any process of this run the manifest did not list (a lost manifest, an `up` killed midway).
  for (const pid of await findRunProcesses(marker(run))) {
    log(`   unlisted process (pid ${pid}): ${await stopProcess(pid, marker(run))}`);
  }
  const database = databaseName(run);
  const realm = realmName(run);
  if (superuserUrl === undefined) {
    log(`   database ${database}: no disposable PostgreSQL instance, nothing to drop`);
  } else {
    log(`   database ${database}: ${(await dropDatabase(superuserUrl, database)) ? "dropped" : "already gone"}`);
    log(`   roles envelope_app_${run}, envelope_queue_${run}: ${(await dropRunRoles(superuserUrl, run)) ? "dropped" : "already gone"}`);
  }
  log(`   realm ${realm}: ${(await keycloak.deleteRealm(realm)) ? "deleted" : "already gone"}`);
  if (removeRunDir && runDir && path.basename(runDir) === run && existsSync(runDir)) {
    await rm(runDir, { recursive: true, force: true });
    log(`   run directory ${runDir}: removed`);
  }
}

/** A path from the command line, relative to where the user ran `pnpm` (INIT_CWD), not to `scripts/`. */
function userPath(value: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

async function down(target: string, root: string): Promise<void> {
  const config = await settings("existing");
  let manifest: Manifest | undefined;
  let run: string;
  let runDir: string;
  if (target.endsWith(".json") || target.includes(path.sep)) {
    const file = userPath(target);
    if (!existsSync(file)) {
      throw new Error(`No manifest at ${file}`);
    }
    manifest = await readManifest(file);
    run = manifest.run;
    runDir = path.dirname(file);
  } else {
    run = runOf(target) ?? target;
    assertRunId(run);
    runDir = path.join(root, run);
    const file = path.join(runDir, MANIFEST_FILE);
    if (existsSync(file)) {
      manifest = await readManifest(file);
    }
  }
  log(`== Removing run ${run}`);
  await teardown(run, config, manifest?.processes ?? {}, runDir, true);
}

async function sweep(root: string, olderThanHours: number): Promise<void> {
  const config = await settings("existing");
  const cutoff = Date.now() - olderThanHours * 3_600_000;
  const isOld = (createdAt: Date | undefined): boolean => createdAt !== undefined && createdAt.getTime() < cutoff;
  log(`== Sweeping environments created more than ${olderThanHours} h ago`);

  const removed = new Set<string>();
  if (existsSync(root)) {
    await assertPrivate(root, "directory");
    for (const entry of await readdir(root)) {
      if (!RUN_DIR_NAME.test(entry)) {
        continue;
      }
      const runDir = path.join(root, entry);
      const file = path.join(runDir, MANIFEST_FILE);
      const manifest = existsSync(file) ? await readManifest(file).catch(() => undefined) : undefined;
      // A run directory with no readable manifest (an `up` that failed early) ages by its modification time.
      const createdAt = manifest ? new Date(manifest.createdAt) : (await stat(runDir)).mtime;
      if (isOld(createdAt)) {
        log(`== Run ${entry} (${manifest ? "manifest" : "run directory without a manifest"})`);
        await teardown(entry, config, manifest?.processes ?? {}, runDir, true);
        removed.add(entry);
      }
    }
  }

  // Leftovers with no run directory: a run whose database or realm is old enough is removed
  // whole, its processes included.
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
  if (config.superuserUrl !== undefined) {
    // Roles are listed before databases: a run's roles are created after its database, so a run
    // being brought up right now never shows roles without its database here.
    const runsWithRoles = await listRunsWithRoles(config.superuserUrl);
    const databases = await listExploreDatabases(config.superuserUrl);
    for (const db of databases) {
      consider("database", db.name, db.createdAt);
    }
    // Roles whose database is already gone (a teardown stopped between the two).
    for (const run of runsWithRoles) {
      if (!removed.has(run) && !databases.some((db) => runOf(db.name) === run)) {
        log(`   roles of run ${run}: their database is gone, ${(await dropRunRoles(config.superuserUrl, run)) ? "dropped" : "already gone"}`);
      }
    }
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
  const rootOption = option(args, "--root");
  const root = rootOption === undefined ? defaultRoot() : userPath(rootOption);
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
