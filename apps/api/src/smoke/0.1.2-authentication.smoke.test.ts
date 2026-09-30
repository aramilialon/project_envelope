/**
 * Certifies 0.1.2 Authentication's own "done when" (every endpoint rejects
 * missing or foreign tokens, #10) against the real process: starts the
 * actual compiled server (main.ts) as a subprocess and exercises it, with
 * real Keycloak-issued tokens, over a real HTTP connection — not
 * buildApp()+inject() (ADR 0007). GET /me only exists to give this test (and
 * #10's) a real, permanently-registered protected route (#235).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { generateKeyPair, SignJWT } from "jose";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { ensureQueueRoleLogin, queueConnectionString } from "../test-helpers/queue-role.ts";
import { TEST_VAPID_PRIVATE_KEY, TEST_VAPID_PUBLIC_KEY, TEST_VAPID_SUBJECT } from "../test-helpers/vapid-keys.ts";
import { startServer, type RunningServer } from "./support.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}
if (!process.env.KEYCLOAK_ADMIN_PASSWORD) {
  throw new Error("Set KEYCLOAK_ADMIN_PASSWORD (the value from infra/.env) before running the integration tests");
}

describe("smoke: 0.1.2 Authentication, against the real process", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let server: RunningServer;
  let prodServer: RunningServer;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    await ensureQueueRoleLogin(superuserPool);
    realm = await setUpKeycloakTestRealm();

    const baseEnv = {
      HOST: "127.0.0.1",
      APP_DATABASE_URL: appConnectionString(databaseUrl),
      QUEUE_DATABASE_URL: queueConnectionString(databaseUrl),
      VAPID_SUBJECT: TEST_VAPID_SUBJECT,
      VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
      KEYCLOAK_ISSUER: realm.issuer,
      KEYCLOAK_AUDIENCE: realm.audience,
      LOG_LEVEL: "fatal",
    };
    server = await startServer({ ...baseEnv, PORT: "3902" });
    prodServer = await startServer({ ...baseEnv, PORT: "3903", NODE_ENV: "production" });
  });

  after(async () => {
    await server.stop();
    await prodServer.stop();
    await realm.teardown();
    await superuserPool.end();
  });

  it("rejects a real GET /me request with no token", async () => {
    const response = await fetch(`${server.baseUrl}/me`);
    assert.equal(response.status, 401);
  });

  it("accepts a real GET /me request with a real, valid token", async () => {
    const token = await realm.getUserToken();
    const response = await fetch(`${server.baseUrl}/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { userId?: string };
    assert.ok(body.userId, "expected a userId in the response");
  });

  it("still answers a real GET /health request with no token", async () => {
    const response = await fetch(`${server.baseUrl}/health`);
    assert.equal(response.status, 200);
  });

  it("does not register GET /me when NODE_ENV is production", async () => {
    const token = await realm.getUserToken();
    const response = await fetch(`${prodServer.baseUrl}/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 404);
  });

  it("rejects a real request with a tampered signature, not just a missing header", async () => {
    const token = await realm.getUserToken();
    const tampered = `${token.slice(0, -4)}abcd`;
    const response = await fetch(`${server.baseUrl}/me`, { headers: { authorization: `Bearer ${tampered}` } });
    assert.equal(response.status, 401);
  });

  it("rejects a real request with a token issued for a different audience", async () => {
    const token = await realm.getTokenWithMismatchedAudience();
    const response = await fetch(`${server.baseUrl}/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401);
  });

  it("rejects a real request with a token forged by an untrusted key", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(realm.issuer)
      .setAudience(realm.audience)
      .setExpirationTime("5m")
      .sign(privateKey);
    const response = await fetch(`${server.baseUrl}/me`, { headers: { authorization: `Bearer ${forged}` } });
    assert.equal(response.status, 401);
  });
});
