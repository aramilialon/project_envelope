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

describe("assignments routes", () => {
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
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;

    token = await realm.getUserToken();
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments`,
      headers: { authorization: `Bearer ${token}` },
      payload: { entries: [] },
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
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments`,
      payload: { entries: [] },
    });
    assert.equal(response.statusCode, 401);
  });

  it("creates a batch and undoes it", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments`,
      headers: auth,
      payload: {
        entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 5000 }],
      },
    });
    assert.equal(created.statusCode, 201);
    const entry = created.json().entries[0];
    assert.equal(entry.destinationCategoryId, categoryId);
    assert.equal(entry.amountCents, 5000);

    const undone = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignment-batches/${entry.batchId}/undo`,
      headers: auth,
    });
    assert.equal(undone.statusCode, 201);
    assert.equal(undone.json().entries[0].reverses, entry.id);

    const undoneAgain = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignment-batches/${entry.batchId}/undo`,
      headers: auth,
    });
    assert.equal(undoneAgain.statusCode, 201);
    assert.deepEqual(undoneAgain.json().entries, []);
  });

  it("undoes a single row and reports already_reversed on a second try", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments`,
      headers: auth,
      payload: {
        entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 250 }],
      },
    });
    const entry = created.json().entries[0];

    const undone = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments/${entry.id}/undo`,
      headers: auth,
    });
    assert.equal(undone.statusCode, 201);

    const again = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments/${entry.id}/undo`,
      headers: auth,
    });
    assert.equal(again.statusCode, 409);
  });

  it("rejects an entry naming an unknown category", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: randomUUID(), amountCents: 100 }],
      },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects an empty entries array", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments`,
      headers: { authorization: `Bearer ${token}` },
      payload: { entries: [] },
    });
    assert.equal(response.statusCode, 400);
  });

  it("undoing an unknown batch is a 404", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignment-batches/${randomUUID()}/undo`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 404);
  });

  it("undoing an unknown entry is a 404", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/assignments/${randomUUID()}/undo`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 404);
  });
});
