import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

describe("accounts routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;

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

    workspaceId = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Mine', 'EUR', 'Europe/Rome')",
      [workspaceId],
    );

    token = await realm.getUserToken();
    // No membership yet, so this 404s (no route matches without a workspace) or 403s — either
    // way, the global auth + user-mapper preHandlers already ran and created the local user.
    await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts`, headers: { authorization: `Bearer ${token}` } });
    const subject = decodeJwt(token).sub;
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      subject,
    ]);
    const userId = rows[0]?.id;
    assert.ok(userId, "expected the user mapper to have created a local user for this token's subject");
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [
      userId,
      workspaceId,
    ]);
  });

  after(async () => {
    await app.close();
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await realm.teardown();
    await superuserPool.end();
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts` });
    assert.equal(response.statusCode, 401);
  });

  it("creates, lists and closes an account", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: auth,
      payload: { name: "Checking", type: "checking", currency: "EUR" },
    });
    assert.equal(created.statusCode, 201);
    const account = created.json();
    assert.equal(account.name, "Checking");
    assert.equal(account.onBudget, true);
    assert.equal(account.paymentCategoryId, null);

    const listed = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts`, headers: auth });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json().accounts.some((a: { id: string }) => a.id === account.id));

    const closed = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${account.id}/close`,
      headers: auth,
    });
    assert.equal(closed.statusCode, 200);
    assert.ok(closed.json().closedAt);

    const closedAgain = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${account.id}/close`,
      headers: auth,
    });
    assert.equal(closedAgain.statusCode, 404);
  });

  it("creating an on-budget credit card links a payment category", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Visa", type: "credit_card", currency: "EUR" },
    });
    assert.equal(response.statusCode, 201);
    assert.ok(response.json().paymentCategoryId);
  });

  it("rejects an invalid account body", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "", type: "not-a-type", currency: "EUR" },
    });
    assert.equal(response.statusCode, 400);
  });
});
