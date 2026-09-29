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

describe("quick assign routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let accountId: string;
  let groupId: string;
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
    const account = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    accountId = account.rows[0]!.id;
    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    groupId = group.rows[0]!.id;
    const category = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, groupId],
    );
    categoryId = category.rows[0]!.id;

    token = await realm.getUserToken();
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/quick-assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
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
      url: `/workspaces/${workspaceId}/quick-assign`,
      payload: { month: "2026-09", scope: { kind: "all" }, mode: "fund_targets" },
    });
    assert.equal(response.statusCode, 401);
  });

  it("covers overspending for a category, scoped to all", async () => {
    const auth = { authorization: `Bearer ${token}` };
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-01", splits: [{ categoryId: null, amountCents: 100_000 }] },
    });
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-10", splits: [{ categoryId, amountCents: -5_000 }] },
    });

    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/quick-assign`,
      headers: auth,
      payload: { month: "2026-09", scope: { kind: "all" }, mode: "cover_overspending" },
    });
    assert.equal(response.statusCode, 201);
    const entries = response.json().entries as Array<{ destinationCategoryId: string; amountCents: number }>;
    const entry = entries.find((e) => e.destinationCategoryId === categoryId);
    assert.equal(entry?.amountCents, 5_000);
  });

  it("scopes to a single group", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/quick-assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { month: "2026-09", scope: { kind: "group", groupId }, mode: "cover_overspending" },
    });
    assert.equal(response.statusCode, 201);
  });

  it("rejects an unknown mode", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/quick-assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { month: "2026-09", scope: { kind: "all" }, mode: "not-a-mode" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects a group scope naming an unknown group", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/quick-assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { month: "2026-09", scope: { kind: "group", groupId: randomUUID() }, mode: "cover_overspending" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects an invalid month with a translatable error", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/quick-assign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { month: "not-a-month", scope: { kind: "all" }, mode: "cover_overspending" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_month");
  });
});
