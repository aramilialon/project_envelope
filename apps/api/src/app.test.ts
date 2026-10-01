/**
 * Proves #10's actual point: buildApp's global preHandlers reject a missing
 * or foreign token on a route that never mentions auth itself, unlike
 * src/auth/workspace-membership.test.ts, which wires the same preHandlers by
 * hand on a bespoke Fastify instance.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { SignJWT, generateKeyPair } from "jose";

import { buildApp, type App } from "./app.ts";
import { createWorkspaceMembershipPreHandler, registerWorkspaceScope } from "./auth/workspace-membership.ts";
import { loadConfig } from "./config.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "./db/migrate.ts";
import { createPool, type DbPool } from "./db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "./test-helpers/app-role.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "./test-helpers/keycloak.ts";

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

describe("every route rejects a missing or foreign token", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;

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

    // Stands in for a future protected route: it only opts into the
    // workspace-specific check, proving the global hooks in app.ts already
    // cover auth and user mapping without repeating them here.
    registerWorkspaceScope(app.fastify);
    app.fastify.get(
      "/workspaces/:workspaceId/ping",
      { preHandler: createWorkspaceMembershipPreHandler(app.pool) },
      async () => ({ ok: true }),
    );

    workspaceId = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Mine', 'EUR', 'Europe/Rome')",
      [workspaceId],
    );
  });

  after(async () => {
    await app.close();
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await realm.teardown();
    await superuserPool.end();
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/ping` });
    assert.equal(response.statusCode, 401);
  });

  it("rejects an expired token", async () => {
    const token = await realm.getUserToken();
    await sleep(4000); // the test realm's access tokens live 3 seconds (see test-helpers/keycloak.ts)
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/ping`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 401);
  });

  it("rejects a token from an untrusted issuer", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("http://example.com/realms/not-envelope")
      .setAudience(realm.audience)
      .setExpirationTime("5m")
      .sign(privateKey);
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/ping`,
      headers: { authorization: `Bearer ${forged}` },
    });
    assert.equal(response.statusCode, 401);
  });

  it("rejects a token issued for a different audience", async () => {
    const token = await realm.getTokenWithMismatchedAudience();
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/ping`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 401);
  });

  it("rejects a valid token for a workspace the user does not belong to", async () => {
    const token = await realm.getUserToken();
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/ping`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 403);
  });

  it("does not require a token for the health check", async () => {
    const response = await app.fastify.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
  });
});

describe("CORS (#48)", () => {
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
        WEB_ORIGIN: "http://localhost:5173",
      }),
    );
  });

  after(async () => {
    await app.close();
    await realm.teardown();
    await superuserPool.end();
  });

  it("answers with the configured web origin, not a hardcoded one", async () => {
    // @fastify/cors, given a single string (not a function or a regex), always answers with
    // that exact value regardless of the request's own Origin header — the real enforcement
    // happens client-side, in the browser, which discards a response whose header does not
    // match its own origin. What this proves is that the value comes from WEB_ORIGIN, not a
    // hardcoded string: a differently configured app answers with its own origin instead.
    const response = await app.fastify.inject({ method: "GET", url: "/health", headers: { origin: "http://localhost:5173" } });
    assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5173");

    const otherApp = buildApp(
      loadConfig({
        APP_DATABASE_URL: appConnectionString(databaseUrl),
        KEYCLOAK_ISSUER: realm.issuer,
        KEYCLOAK_AUDIENCE: realm.audience,
        WEB_ORIGIN: "https://envelope.example.net",
      }),
    );
    try {
      const otherResponse = await otherApp.fastify.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "http://localhost:5173" },
      });
      assert.equal(otherResponse.headers["access-control-allow-origin"], "https://envelope.example.net");
    } finally {
      await otherApp.close();
    }
  });

  it("allows PATCH, PUT and DELETE preflight requests, not just @fastify/cors's own GET/HEAD/POST default (#315)", async () => {
    const response = await app.fastify.inject({
      method: "OPTIONS",
      url: "/workspaces/00000000-0000-0000-0000-000000000000/accounts/00000000-0000-0000-0000-000000000000/close",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization",
      },
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers["access-control-allow-methods"], "GET, HEAD, POST, PATCH, PUT, DELETE");
  });
});
