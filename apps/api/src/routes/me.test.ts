import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

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

describe("GET /me", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;

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
    );
  });

  after(async () => {
    await app.close();
    await realm.teardown();
    await superuserPool.end();
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({ method: "GET", url: "/me" });
    assert.equal(response.statusCode, 401);
  });

  it("returns the local user id for a request with a valid token", async () => {
    const token = await realm.getUserToken();
    const response = await app.fastify.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().userId, "expected a userId in the response");
  });

  it("is not registered when NODE_ENV is production", async () => {
    const prodApp = buildApp(
      loadConfig({
        APP_DATABASE_URL: appConnectionString(databaseUrl),
        KEYCLOAK_ISSUER: realm.issuer,
        KEYCLOAK_AUDIENCE: realm.audience,
        NODE_ENV: "production",
      }),
    );
    try {
      // A valid token, so a 404 can only mean the route itself is gone, not
      // that the global auth preHandler (which also runs ahead of Fastify's
      // own not-found handling) rejected the request first.
      const token = await realm.getUserToken();
      const response = await prodApp.fastify.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.statusCode, 404);
    } finally {
      await prodApp.close();
    }
  });
});
