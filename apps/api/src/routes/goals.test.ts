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

describe("goals routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let categoryId: string;
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
    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Holidays', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;

    token = await realm.getUserToken();
    await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal?month=2026-09`,
      headers: { authorization: `Bearer ${token}` },
    });
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
    const response = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
      payload: { kind: "monthly", amountCents: 1000 },
    });
    assert.equal(response.statusCode, 401);
  });

  it("sets, reads with progress, and deletes a goal", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const set = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
      headers: auth,
      payload: { kind: "monthly", amountCents: 60000 },
    });
    assert.equal(set.statusCode, 200);
    assert.equal(set.json().kind, "monthly");

    const read = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal?month=2026-09`,
      headers: auth,
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().asks, 60000);
    assert.equal(read.json().missing, 60000); // nothing assigned yet

    const removed = await app.fastify.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
      headers: auth,
    });
    assert.equal(removed.statusCode, 204);

    const readAfterDelete = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal?month=2026-09`,
      headers: auth,
    });
    assert.equal(readAfterDelete.statusCode, 404);
  });

  it("rejects a repeating goal missing every", async () => {
    const response = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "repeating", amountCents: 60000, dueMonth: "2026-12" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects a monthly goal that also sets dueMonth", async () => {
    const response = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "monthly", amountCents: 60000, dueMonth: "2026-12" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects a goal for an unknown category", async () => {
    const response = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/categories/${randomUUID()}/goal`,
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "monthly", amountCents: 60000 },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects a GET with no month", async () => {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/categories/${categoryId}/goal`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 400);
  });
});
