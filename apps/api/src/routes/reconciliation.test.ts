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

describe("reconciliation routes", () => {
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
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;

    token = await realm.getUserToken();
    await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/reconciliation-candidates?date=2026-01-01`,
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
      url: `/workspaces/${workspaceId}/accounts/${accountId}/reconciliation-candidates?date=2026-01-01`,
    });
    assert.equal(response.statusCode, 401);
  });

  it("lists candidates, reconciles a matching batch, and unlocks it again", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-02-10", status: "cleared", splits: [{ categoryId, amountCents: -2000 }] },
    });
    const transaction = created.json();

    const candidates = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/reconciliation-candidates?date=2026-02-28`,
      headers: auth,
    });
    assert.equal(candidates.statusCode, 200);
    assert.ok(candidates.json().clearedTransactions.some((t: { id: string }) => t.id === transaction.id));

    const reconciled = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/reconciliations`,
      headers: auth,
      payload: { date: "2026-02-28", statementBalanceCents: -2000, tickedTransactionIds: [transaction.id] },
    });
    assert.equal(reconciled.statusCode, 201);
    assert.equal(reconciled.json().outcome, "reconciled");

    const unlocked = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/transactions/${transaction.id}/unlock-reconciliation`,
      headers: auth,
    });
    assert.equal(unlocked.statusCode, 200);
    assert.equal(unlocked.json().status, "cleared");
  });

  it("reports a difference with no suggestion, then resolves it with an adjustment", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-03-10", status: "cleared", splits: [{ categoryId, amountCents: -1000 }] },
    });
    const transaction = created.json();

    const difference = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/reconciliations`,
      headers: auth,
      payload: { date: "2026-03-31", statementBalanceCents: -1250, tickedTransactionIds: [transaction.id] },
    });
    assert.equal(difference.statusCode, 200);
    assert.equal(difference.json().outcome, "difference");
    assert.equal(difference.json().differenceCents, -250);

    const adjusted = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/reconciliations`,
      headers: auth,
      payload: {
        date: "2026-03-31",
        statementBalanceCents: -1250,
        tickedTransactionIds: [transaction.id],
        adjustment: { categoryId: null },
      },
    });
    assert.equal(adjusted.statusCode, 201);
    assert.equal(adjusted.json().outcome, "reconciled");
  });

  it("rejects an adjustment naming an unknown category", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/reconciliations`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        date: "2026-04-30",
        statementBalanceCents: -100,
        tickedTransactionIds: [],
        adjustment: { categoryId: randomUUID() },
      },
    });
    assert.equal(response.statusCode, 400);
  });

  it("rejects a ticked id that is not eligible, with a translatable error", async () => {
    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { occurredAt: "2026-05-10", status: "pending", splits: [{ categoryId, amountCents: -100 }] },
    });
    const transaction = created.json();

    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/reconciliations`,
      headers: { authorization: `Bearer ${token}` },
      payload: { date: "2026-05-31", statementBalanceCents: -100, tickedTransactionIds: [transaction.id] },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "unknown_transaction");
  });

  it("unlocking an unknown transaction is a 404", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/transactions/${randomUUID()}/unlock-reconciliation`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 404);
  });

  it("unlocking a non-reconciled transaction is a 409", async () => {
    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { occurredAt: "2026-06-10", status: "cleared", splits: [{ categoryId, amountCents: -100 }] },
    });
    const transaction = created.json();

    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/transactions/${transaction.id}/unlock-reconciliation`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 409);
  });
});
