import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { decodeJwt } from "jose";

import { buildApp, type App } from "../app.ts";
import { loadConfig } from "../config.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../test-helpers/keycloak.ts";

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

describe("device tokens routes (#61)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let token: string;
  let userId: string;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    realm = await setUpKeycloakTestRealm();

    app = buildApp(
      loadConfig({
        APP_DATABASE_URL: appConnectionString(databaseUrl),
        KEYCLOAK_ISSUER: realm.issuer,
        KEYCLOAK_AUDIENCE: realm.audience,
      }),
      undefined,
      "test-vapid-public-key",
    );

    token = await realm.getUserToken();
    // One request first, so the user-mapper preHandler creates this token's local user.
    await app.fastify.inject({ method: "GET", url: "/me/push-public-key", headers: { authorization: `Bearer ${token}` } });
    const subject = decodeJwt(token).sub;
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      subject,
    ]);
    userId = rows[0]!.id;
  });

  after(async () => {
    await app.close();
    await superuserPool.query("DELETE FROM device_tokens WHERE user_id = $1", [userId]);
    await superuserPool.query("DELETE FROM users WHERE id = $1", [userId]);
    await realm.teardown();
    await superuserPool.end();
  });

  it("does not register the opt-in routes at all without a VAPID public key", async () => {
    const bare = buildApp(
      loadConfig({ APP_DATABASE_URL: appConnectionString(databaseUrl), KEYCLOAK_ISSUER: realm.issuer, KEYCLOAK_AUDIENCE: realm.audience }),
    );
    const response = await bare.fastify.inject({ method: "GET", url: "/me/push-public-key", headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 404);
    await bare.close();
  });

  it("returns the public key to any signed-in caller, no workspace needed", async () => {
    const response = await app.fastify.inject({ method: "GET", url: "/me/push-public-key", headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { publicKey: "test-vapid-public-key" });
  });

  it("rejects an unauthenticated request", async () => {
    const response = await app.fastify.inject({ method: "POST", url: "/me/device-tokens", payload: { platform: "web", token: "x" } });
    assert.equal(response.statusCode, 401);
  });

  it("rejects an invalid platform or a missing token", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const badPlatform = await app.fastify.inject({ method: "POST", url: "/me/device-tokens", headers: auth, payload: { platform: "fax", token: "x" } });
    assert.equal(badPlatform.statusCode, 400);
    const noToken = await app.fastify.inject({ method: "POST", url: "/me/device-tokens", headers: auth, payload: { platform: "web" } });
    assert.equal(noToken.statusCode, 400);
  });

  it("registers a device token, idempotently on a repeat", async () => {
    const payload = { platform: "web", token: JSON.stringify({ endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } }) };
    const first = await app.fastify.inject({ method: "POST", url: "/me/device-tokens", headers: { authorization: `Bearer ${token}` }, payload });
    assert.equal(first.statusCode, 204);
    const second = await app.fastify.inject({ method: "POST", url: "/me/device-tokens", headers: { authorization: `Bearer ${token}` }, payload });
    assert.equal(second.statusCode, 204);

    const { rows } = await superuserPool.query<{ count: string }>(
      "SELECT count(*) FROM device_tokens WHERE user_id = $1 AND platform = 'web'",
      [userId],
    );
    assert.equal(rows[0]!.count, "1");
  });

  it("removes a device token on opt-out", async () => {
    const payload = { platform: "web", token: JSON.stringify({ endpoint: "https://push.example/xyz", keys: { p256dh: "k", auth: "a" } }) };
    await app.fastify.inject({ method: "POST", url: "/me/device-tokens", headers: { authorization: `Bearer ${token}` }, payload });

    const response = await app.fastify.inject({ method: "DELETE", url: "/me/device-tokens", headers: { authorization: `Bearer ${token}` }, payload });
    assert.equal(response.statusCode, 204);

    const { rows } = await superuserPool.query<{ count: string }>(
      "SELECT count(*) FROM device_tokens WHERE user_id = $1 AND token = $2",
      [userId, payload.token],
    );
    assert.equal(rows[0]!.count, "0");
  });
});
