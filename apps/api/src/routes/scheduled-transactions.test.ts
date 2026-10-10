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

describe("scheduled transactions routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let accountId: string;
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
    const category = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Rent', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;

    token = await realm.getUserToken();
    await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/scheduled-transactions`,
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
      method: "GET",
      url: `/workspaces/${workspaceId}/scheduled-transactions`,
    });
    assert.equal(response.statusCode, 401);
  });

  it("creates, lists, updates and deletes a scheduled transaction", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions`,
      headers: auth,
      payload: {
        accountId,
        payee: "Landlord",
        nextDueDate: "2026-10-01",
        recurEvery: 1,
        recurUnit: "month",
        splits: [{ categoryId, amountCents: 90_000 }],
      },
    });
    assert.equal(created.statusCode, 201);
    const scheduledTransactionId = created.json().id as string;
    assert.equal(created.json().payee, "Landlord");

    const list = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/scheduled-transactions`,
      headers: auth,
    });
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().scheduledTransactions.some((s: { id: string }) => s.id === scheduledTransactionId));

    const updated = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/scheduled-transactions/${scheduledTransactionId}`,
      headers: auth,
      payload: { nextDueDate: "2026-10-05" },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().nextDueDate, "2026-10-05");

    const removed = await app.fastify.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/scheduled-transactions/${scheduledTransactionId}`,
      headers: auth,
    });
    assert.equal(removed.statusCode, 204);

    const removedAgain = await app.fastify.inject({
      method: "DELETE",
      url: `/workspaces/${workspaceId}/scheduled-transactions/${scheduledTransactionId}`,
      headers: auth,
    });
    assert.equal(removedAgain.statusCode, 404);
  });

  it("creates and records a scheduled income transaction, with no category (#347)", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions`,
      headers: auth,
      payload: {
        accountId,
        payee: "Salary",
        nextDueDate: "2026-10-15",
        recurEvery: 1,
        recurUnit: "month",
        splits: [{ categoryId: null, amountCents: 300_000 }],
      },
    });
    assert.equal(created.statusCode, 201);
    const scheduledTransactionId = created.json().id as string;
    assert.deepEqual(
      created.json().splits.map((s: { categoryId: string | null; amountCents: number }) => [s.categoryId, s.amountCents]),
      [[null, 300_000]],
    );

    const recorded = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions/${scheduledTransactionId}/record`,
      headers: auth,
    });
    assert.equal(recorded.statusCode, 201);
    assert.deepEqual(
      recorded.json().transaction.splits.map((s: { categoryId: string | null; amountCents: number }) => [s.categoryId, s.amountCents]),
      [[null, 300_000]],
    );
  });

  it("rejects an unknown category", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        accountId,
        nextDueDate: "2026-10-01",
        recurEvery: 1,
        recurUnit: "month",
        splits: [{ categoryId: randomUUID(), amountCents: 1_000 }],
      },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects an invalid recurrence unit", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        accountId,
        nextDueDate: "2026-10-01",
        recurEvery: 1,
        recurUnit: "fortnight",
        splits: [{ categoryId, amountCents: 1_000 }],
      },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects a missing splits array", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { accountId, nextDueDate: "2026-10-01", recurEvery: 1, recurUnit: "month", splits: [] },
    });
    assert.equal(response.statusCode, 400);
  });

  it("records a scheduled transaction: a real transaction, and nextDueDate advances", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions`,
      headers: auth,
      payload: {
        accountId,
        payee: "Landlord",
        nextDueDate: "2026-09-01",
        recurEvery: 1,
        recurUnit: "month",
        splits: [{ categoryId, amountCents: 90_000 }],
      },
    });
    const scheduledTransactionId = created.json().id as string;

    const recorded = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions/${scheduledTransactionId}/record`,
      headers: auth,
    });
    assert.equal(recorded.statusCode, 201);
    const body = recorded.json();
    assert.equal(body.transaction.payee, "Landlord");
    assert.deepEqual(body.transaction.splits.map((s: { categoryId: string; amountCents: number }) => [s.categoryId, s.amountCents]), [
      [categoryId, -90_000],
    ]);
    assert.equal(body.scheduledTransaction.nextDueDate, "2026-10-01");
  });

  it("recording an unknown scheduled transaction reports 404", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions/${randomUUID()}/record`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 404);
  });

  it("skips a scheduled transaction: nextDueDate advances, no transaction created", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions`,
      headers: auth,
      payload: {
        accountId,
        nextDueDate: "2026-09-10",
        recurEvery: 1,
        recurUnit: "month",
        splits: [{ categoryId, amountCents: 3_000 }],
      },
    });
    const scheduledTransactionId = created.json().id as string;

    const skipped = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions/${scheduledTransactionId}/skip`,
      headers: auth,
    });
    assert.equal(skipped.statusCode, 200);
    assert.equal(skipped.json().nextDueDate, "2026-10-10");
  });

  it("skipping an unknown scheduled transaction reports 404", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions/${randomUUID()}/skip`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 404);
  });
});
