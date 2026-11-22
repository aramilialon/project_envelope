/**
 * Keycloak for integration tests, through the admin REST API. A test run has one throwaway
 * realm (#639): `keycloak-global-setup.ts` creates it before the first test file starts and
 * deletes it after the last one ends, and `setUpKeycloakTestRealm()` gives each file a user of
 * its own in it. A file run on its own, without that global setup (`node --test <file>`),
 * creates a realm of its own instead and deletes it in `teardown()`.
 *
 * The realm's access tokens live a minute (long enough for a slow test on a loaded machine,
 * #519). It has two clients with different audiences, a third client with the matching audience
 * whose tokens live only `SHORT_LIVED_TOKEN_SECONDS` (for the tests that wait for a token to
 * expire, on purpose), and the users the files create. Every file of a run shares the realm, so
 * no test changes anything realm-wide (its settings, clients, keys); a test changes only the
 * users it created. The admin token lives a minute too, so every admin call made after the setup
 * (a new user, the teardown) asks for a fresh one: a test file that runs longer, such as the
 * random walk (#80), would otherwise get 401 from them.
 *
 * A realm's name says which process created it, on which host, and when (`testRealmName`), so a
 * run that crashed or was killed before it could delete its realm does not leave it there for
 * long: every global setup first deletes the test realms whose process on this host is gone, and
 * those from another host older than `LEFTOVER_REALM_AGE_MS` (`sweepLeftoverTestRealms`).
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { decodeJwt } from "jose";

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? "http://127.0.0.1:8080";
const MATCHING_AUDIENCE = "envelope-api";
const MISMATCHED_AUDIENCE = "some-other-api";
const ACCESS_TOKEN_LIFESPAN_SECONDS = 60;
/** How long a token from `getShortLivedUserToken()` lives. */
export const SHORT_LIVED_TOKEN_SECONDS = 2;

/** The environment variable through which the global setup hands the run's realm to every test file. */
export const RUN_REALM_ENV = "ENVELOPE_TEST_KEYCLOAK_REALM";
/** A test realm from another host, or from before #639, older than this is deleted by the next sweep: its process cannot be checked. */
export const LEFTOVER_REALM_AGE_MS = 24 * 60 * 60 * 1000;

const TEST_REALM_PATTERN = /^envelope-test-run-([0-9a-f]{8})-([1-9][0-9]*)-([0-9a-z]+)-[0-9a-f]{8}$/;
/** The name the helper gave every realm, one per test file, before #639: it says neither who created it nor when. */
const PER_FILE_REALM_PATTERN = /^envelope-test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface KeycloakTestRealm {
  readonly issuer: string;
  readonly audience: string;
  getUserToken(): Promise<string>;
  /** A token for the same user that expires after `SHORT_LIVED_TOKEN_SECONDS`, for tests of expiry. */
  getShortLivedUserToken(): Promise<string>;
  getTokenWithMismatchedAudience(): Promise<string>;
  /** A token for a brand-new user in the same realm — for tests needing several distinct local users (e.g. #24's per-role checks). */
  getTokenForNewUser(): Promise<string>;
  /** A brand-new user whose token can be fetched again, for a run that outlives one token (the random walk, #80). */
  createUser(): Promise<KeycloakTestUser>;
  updateUserEmail(email: string): Promise<void>;
  /** Deletes the realm if this file created it; the run's shared realm is left to the global teardown. */
  teardown(): Promise<void>;
}

export interface KeycloakTestUser {
  /** A fresh access token for this user, valid for the realm's token lifespan. */
  getToken(): Promise<string>;
}

/** A realm the helper created: its name, and the secret of its three clients. */
export interface TestRealmCredentials {
  readonly realm: string;
  readonly clientSecret: string;
}

/**
 * Gives the calling test file a user of its own in the run's realm, or, when the file runs
 * without the global setup, a realm of its own with that user in it.
 */
export async function setUpKeycloakTestRealm(): Promise<KeycloakTestRealm> {
  const adminPassword = requireAdminPassword();
  const runRealm = readRunRealm();
  const { realm, clientSecret } = runRealm ?? (await createTestRealm(adminPassword));
  // Unique per file: apps/api's own users.email is UNIQUE, and the files of a run share the realm.
  const username = `test-user-${randomUUID()}`;
  const password = randomUUID();
  let userId: string;
  try {
    userId = await createUser(await getAdminToken(adminPassword), realm, username, password);
  } catch (error) {
    if (!runRealm) {
      await deleteTestRealm(adminPassword, realm);
    }
    throw error;
  }

  const newUser = async (): Promise<{ username: string; password: string }> => {
    const otherUsername = `test-user-${randomUUID()}`;
    const otherPassword = randomUUID();
    await createUser(await getAdminToken(adminPassword), realm, otherUsername, otherPassword);
    return { username: otherUsername, password: otherPassword };
  };

  return {
    issuer: `${KEYCLOAK_URL}/realms/${realm}`,
    audience: MATCHING_AUDIENCE,
    getUserToken: () => getUserAccessToken(realm, "envelope-api", clientSecret, username, password),
    getShortLivedUserToken: () => getUserAccessToken(realm, "envelope-api-short-lived", clientSecret, username, password),
    getTokenWithMismatchedAudience: () => getUserAccessToken(realm, "envelope-other", clientSecret, username, password),
    getTokenForNewUser: async () => {
      const other = await newUser();
      return getUserAccessToken(realm, "envelope-api", clientSecret, other.username, other.password);
    },
    createUser: async () => {
      const other = await newUser();
      return { getToken: () => getUserAccessToken(realm, "envelope-api", clientSecret, other.username, other.password) };
    },
    updateUserEmail: async (email: string) => {
      await adminRequest(await getAdminToken(adminPassword), "PUT", `/admin/realms/${realm}/users/${userId}`, { email });
    },
    teardown: async () => {
      // The run's realm outlives this file: the other files of the run still use it.
      if (!runRealm) {
        await deleteTestRealm(adminPassword, realm);
      }
    },
  };
}

/**
 * Creates a test realm with its three clients and no user, named after this process
 * (`testRealmName`). A realm left half-made by a failed setup is deleted before the error is
 * thrown again.
 */
export async function createTestRealm(adminPassword: string, realm = testRealmName()): Promise<TestRealmCredentials> {
  const adminToken = await getAdminToken(adminPassword);
  const clientSecret = randomUUID();

  await adminRequest(adminToken, "POST", "/admin/realms", {
    realm,
    enabled: true,
    sslRequired: "none",
    accessTokenLifespan: ACCESS_TOKEN_LIFESPAN_SECONDS,
  });
  try {
    await createClientWithAudience(adminToken, realm, "envelope-api", clientSecret, MATCHING_AUDIENCE);
    await createClientWithAudience(adminToken, realm, "envelope-other", clientSecret, MISMATCHED_AUDIENCE);
    await createClientWithAudience(adminToken, realm, "envelope-api-short-lived", clientSecret, MATCHING_AUDIENCE, {
      "access.token.lifespan": String(SHORT_LIVED_TOKEN_SECONDS),
    });
  } catch (error) {
    await deleteTestRealm(adminPassword, realm);
    throw error;
  }
  return { realm, clientSecret };
}

/** Deletes a test realm; one already gone (deleted by another run's sweep) counts as deleted. */
export async function deleteTestRealm(adminPassword: string, realm: string): Promise<void> {
  await adminRequest(await getAdminToken(adminPassword), "DELETE", `/admin/realms/${encodeURIComponent(realm)}`, undefined, {
    acceptNotFound: true,
  });
}

/** The run's realm the global setup handed down through `RUN_REALM_ENV`, or `undefined` for a file run on its own. */
export function readRunRealm(env: NodeJS.ProcessEnv = process.env): TestRealmCredentials | undefined {
  const value = env[RUN_REALM_ENV];
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = JSON.parse(value) as Partial<TestRealmCredentials>;
  if (typeof parsed.realm !== "string" || typeof parsed.clientSecret !== "string" || !TEST_REALM_PATTERN.test(parsed.realm)) {
    throw new Error(`${RUN_REALM_ENV} does not name a test realm`);
  }
  return { realm: parsed.realm, clientSecret: parsed.clientSecret };
}

/**
 * `envelope-test-run-<host>-<pid>-<start>-<random>`: the first 8 hex digits of the SHA-256 of the
 * host name, the creating process's id, its start time in milliseconds in base 36, and 8 random
 * hex digits.
 */
export function testRealmName(pid = process.pid, startedAt = Date.now(), host = hostTag()): string {
  return `envelope-test-run-${host}-${pid}-${startedAt.toString(36)}-${randomUUID().slice(0, 8)}`;
}

/** Who created a test realm and when, read back from its name; `undefined` for any other name. */
export function parseTestRealmName(realm: string): { host: string; pid: number; startedAt: number } | undefined {
  const match = TEST_REALM_PATTERN.exec(realm);
  if (!match) {
    return undefined;
  }
  const [, host = "", pid = "", startedAt = ""] = match;
  return { host, pid: Number(pid), startedAt: parseInt(startedAt, 36) };
}

/**
 * The host name and, on Linux, the PID namespace (`/proc/self/ns/pid`): two containers with the
 * same host name see different processes under the same ids, so neither must judge the other's.
 */
export function hostTag(name = `${hostname()} ${pidNamespace()}`): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 8);
}

function pidNamespace(): string {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
}

export interface SweepContext {
  readonly now: number;
  readonly host: string;
  /** Whether the process that created a realm at `realmStartedAt` is still running under `pid`. */
  readonly isProcessAlive: (pid: number, realmStartedAt: number) => boolean;
}

/**
 * What a sweep does with a realm: `keep` a test realm whose process on this host is still
 * running, however old (a long walk keeps its realm to the end); `delete` one whose process on
 * this host is gone, and one from another host once it is older than `LEFTOVER_REALM_AGE_MS`;
 * `check-age` for a realm named by the helper before #639, whose name says neither, so its age is
 * read from its users; `keep` anything else, every realm that is not a test realm included.
 */
export function judgeRealm(realm: string, context: SweepContext): "keep" | "delete" | "check-age" {
  if (PER_FILE_REALM_PATTERN.test(realm)) {
    return "check-age";
  }
  const origin = parseTestRealmName(realm);
  if (!origin) {
    return "keep";
  }
  if (origin.host === context.host) {
    return context.isProcessAlive(origin.pid, origin.startedAt) ? "keep" : "delete";
  }
  return context.now - origin.startedAt > LEFTOVER_REALM_AGE_MS ? "delete" : "keep";
}

/**
 * Whether `pid` is a running process that was already running at `realmStartedAt`. A process
 * that started later only reuses the id of the one that created the realm. Where its start time
 * cannot be read (no `/proc`), a running process counts as the realm's.
 */
export function isProcessAlive(pid: number, realmStartedAt: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM: the process exists, it only belongs to another user.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      return false;
    }
  }
  const startedAt = processStartedAt(pid);
  // A few seconds of slack: the start time is read in clock ticks, the boot time in whole seconds.
  return startedAt === undefined || startedAt <= realmStartedAt + 5_000;
}

/** When a process started, in milliseconds since the epoch, from `/proc`; `undefined` where that cannot be read. */
function processStartedAt(pid: number): number | undefined {
  try {
    // Field 22, start time in clock ticks since boot; the fields after the parenthesised command name.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const startTicks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    const bootSeconds = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(bootSeconds)) {
      return undefined;
    }
    return bootSeconds * 1000 + (startTicks * 1000) / clockTicksPerSecond();
  } catch {
    return undefined;
  }
}

let clockTicks: number | undefined;

function clockTicksPerSecond(): number {
  if (clockTicks === undefined) {
    const value = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout?.trim());
    clockTicks = Number.isInteger(value) && value > 0 ? value : 100;
  }
  return clockTicks;
}

/**
 * Deletes the test realms a crashed or killed run left behind (`judgeRealm`), and returns their
 * names. A realm named before #639 is deleted once one of its users is older than
 * `LEFTOVER_REALM_AGE_MS`; one with no user is kept, since it may be a setup still in progress.
 */
export async function sweepLeftoverTestRealms(
  adminPassword: string,
  context: SweepContext = { now: Date.now(), host: hostTag(), isProcessAlive },
): Promise<string[]> {
  const adminToken = await getAdminToken(adminPassword);
  const response = await adminRequest(adminToken, "GET", "/admin/realms?briefRepresentation=true");
  const realms = ((await response.json()) as { realm: string }[]).map(({ realm }) => realm);
  const deleted: string[] = [];
  for (const realm of realms) {
    let verdict = judgeRealm(realm, context);
    if (verdict === "check-age") {
      const users = await adminRequest(adminToken, "GET", `/admin/realms/${realm}/users?first=0&max=1`, undefined, {
        acceptNotFound: true,
      });
      const [user] = users.status === 404 ? [] : ((await users.json()) as { createdTimestamp?: number }[]);
      const createdAt = user?.createdTimestamp;
      verdict = createdAt !== undefined && context.now - createdAt > LEFTOVER_REALM_AGE_MS ? "delete" : "keep";
    }
    if (verdict === "delete") {
      await deleteTestRealm(adminPassword, realm);
      deleted.push(realm);
    }
  }
  return deleted;
}

/**
 * Resolves once `token` is past its own `exp` (a second past it, since `exp` has whole-second
 * precision), so a test of expiry waits exactly as long as the token itself says, not a guess.
 */
export async function waitUntilExpired(token: string): Promise<void> {
  const { exp } = decodeJwt(token);
  if (exp === undefined) {
    throw new Error("expected the token to carry an exp claim");
  }
  const remainingMs = (exp + 1) * 1000 - Date.now();
  if (remainingMs > 0) {
    await sleep(remainingMs);
  }
}

function requireAdminPassword(): string {
  const adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error(
      "Set KEYCLOAK_ADMIN_PASSWORD (the value from infra/.env) to run the Keycloak integration tests",
    );
  }
  return adminPassword;
}

async function getAdminToken(adminPassword: string): Promise<string> {
  const body = await postForm(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    grant_type: "password",
    client_id: "admin-cli",
    username: "admin",
    password: adminPassword,
  });
  return body.access_token as string;
}

async function getUserAccessToken(
  realm: string,
  clientId: string,
  clientSecret: string,
  username: string,
  password: string,
): Promise<string> {
  const body = await postForm(`${KEYCLOAK_URL}/realms/${realm}/protocol/openid-connect/token`, {
    grant_type: "password",
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password,
    scope: "openid",
  });
  return body.access_token as string;
}

async function postForm(url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetchRetryingServerErrors(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function adminRequest(
  adminToken: string,
  method: string,
  path: string,
  body?: unknown,
  { acceptNotFound = false }: { acceptNotFound?: boolean } = {},
): Promise<Response> {
  const response = await fetchRetryingServerErrors(`${KEYCLOAK_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (acceptNotFound && response.status === 404) {
    await response.body?.cancel();
    return response;
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} responded ${response.status}: ${await response.text()}`);
  }
  return response;
}

/**
 * Keycloak answers 500 now and then when several test runs create and delete realms at the same
 * time (#519): a realm deleted by one run can still be in the role cache another run's admin
 * request walks ("Not found in database", a NullPointerException), and the request is rolled
 * back. Such a request succeeds when sent again a moment later, so a 5xx is retried a few times
 * before it counts as a failure; any other status is returned as is.
 */
const SERVER_ERROR_ATTEMPTS = 5;

async function fetchRetryingServerErrors(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status < 500 || attempt === SERVER_ERROR_ATTEMPTS) {
      return response;
    }
    await response.body?.cancel();
    await sleep(250 * attempt);
  }
}

function createdEntityId(response: Response): string {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Keycloak did not return a Location header for the created entity");
  }
  return location.split("/").pop() ?? "";
}

async function createClientWithAudience(
  adminToken: string,
  realm: string,
  clientId: string,
  secret: string,
  audience: string,
  attributes: Record<string, string> = {},
): Promise<void> {
  const response = await adminRequest(adminToken, "POST", `/admin/realms/${realm}/clients`, {
    clientId,
    secret,
    enabled: true,
    publicClient: false,
    directAccessGrantsEnabled: true,
    standardFlowEnabled: false,
    serviceAccountsEnabled: false,
    attributes,
  });
  const internalId = createdEntityId(response);

  await adminRequest(adminToken, "POST", `/admin/realms/${realm}/clients/${internalId}/protocol-mappers/models`, {
    name: "audience-mapper",
    protocol: "openid-connect",
    protocolMapper: "oidc-audience-mapper",
    config: {
      "included.custom.audience": audience,
      "id.token.claim": "false",
      "access.token.claim": "true",
    },
  });
}

async function createUser(adminToken: string, realm: string, username: string, password: string): Promise<string> {
  // firstName/lastName are required: without them Keycloak's user-profile validation silently
  // adds a VERIFY_PROFILE required action at login time, which rejects the password grant with
  // "Account is not fully set up" even though the user's own requiredActions list is empty.
  const response = await adminRequest(adminToken, "POST", `/admin/realms/${realm}/users`, {
    username,
    email: `${username}@example.com`,
    firstName: "Test",
    lastName: "User",
    emailVerified: true,
    enabled: true,
    requiredActions: [],
  });
  const internalId = createdEntityId(response);

  await adminRequest(adminToken, "PUT", `/admin/realms/${realm}/users/${internalId}/reset-password`, {
    type: "password",
    value: password,
    temporary: false,
  });

  return internalId;
}
