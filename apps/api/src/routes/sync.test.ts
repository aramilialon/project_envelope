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

describe("sync routes (#43, #44)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let accountId: string;
  let transactionId: string;
  let token: string;

  async function tokenFor(role: "owner" | "editor" | "read_only"): Promise<string> {
    const t = role === "owner" ? await realm.getUserToken() : await realm.getTokenForNewUser();
    await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts`, headers: { authorization: `Bearer ${t}` } });
    const subject = decodeJwt(t).sub;
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [subject]);
    const userId = rows[0]?.id;
    assert.ok(userId, "expected the user mapper to have created a local user for this token's subject");
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [
      userId,
      workspaceId,
      role,
    ]);
    return t;
  }

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
    const transaction = await superuserPool.query<{ id: string }>(
      "INSERT INTO transactions (workspace_id, account_id, occurred_at, status) VALUES ($1, $2, now(), 'pending') RETURNING id",
      [workspaceId, accountId],
    );
    transactionId = transaction.rows[0]!.id;

    token = await tokenFor("owner");
  });

  after(async () => {
    await app.close();
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await realm.teardown();
    await superuserPool.end();
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({ method: "POST", url: `/workspaces/${workspaceId}/changes`, payload: { changes: [] } });
    assert.equal(response.statusCode, 401);
  });

  it("rejects a read-only member", async () => {
    const readOnlyToken = await tokenFor("read_only");
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${readOnlyToken}` },
      payload: { changes: [{ id: randomUUID(), entityId: transactionId, fieldName: "transactions.memo", hlc: { physical: 1, counter: 0, deviceId: "d" }, value: "x" }] },
    });
    assert.equal(response.statusCode, 403);
  });

  it("rejects a malformed body", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${token}` },
      payload: { changes: [{ id: randomUUID() }] },
    });
    assert.equal(response.statusCode, 400);
  });

  it("applies a batch of changes and reports each one's outcome", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        changes: [
          {
            id: randomUUID(),
            entityId: transactionId,
            fieldName: "transactions.memo",
            hlc: { physical: 2000, counter: 0, deviceId: "device-a" },
            value: "later",
          },
          {
            id: randomUUID(),
            entityId: transactionId,
            fieldName: "transactions.memo",
            hlc: { physical: 1000, counter: 0, deviceId: "device-b" },
            value: "earlier",
          },
          {
            id: randomUUID(),
            entityId: transactionId,
            fieldName: "transactions.occurred_at",
            hlc: { physical: 1000, counter: 0, deviceId: "device-a" },
            value: "2026-10-01",
          },
        ],
      },
    });

    assert.equal(response.statusCode, 201);
    const { results } = response.json() as { results: { id: string; outcome: string }[] };
    assert.deepEqual(
      results.map((r) => r.outcome),
      ["applied", "stale", "unsupported_field"],
    );

    const listed = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: { authorization: `Bearer ${token}` },
    });
    const { transactions } = listed.json() as { transactions: { id: string; memo: string | null }[] };
    assert.equal(transactions.find((t) => t.id === transactionId)?.memo, "later");
  });

  it("rejects a change to a reconciled transaction as locked (#45)", async () => {
    const reconciled = await superuserPool.query<{ id: string }>(
      "INSERT INTO transactions (workspace_id, account_id, occurred_at, status) VALUES ($1, $2, now(), 'reconciled') RETURNING id",
      [workspaceId, accountId],
    );
    const reconciledTransactionId = reconciled.rows[0]!.id;

    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        changes: [
          {
            id: randomUUID(),
            entityId: reconciledTransactionId,
            fieldName: "transactions.memo",
            hlc: { physical: 1000, counter: 0, deviceId: "d" },
            value: "should not apply",
          },
        ],
      },
    });

    assert.equal(response.statusCode, 201);
    const { results } = response.json() as { results: { outcome: string }[] };
    assert.deepEqual(
      results.map((r) => r.outcome),
      ["locked"],
    );
  });

  it("downloads every change when given no since, in clock order", async () => {
    const entityId = randomUUID();
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        changes: [
          { id: randomUUID(), entityId, fieldName: "transactions.memo", hlc: { physical: 9000, counter: 0, deviceId: "d" }, value: "b" },
          { id: randomUUID(), entityId, fieldName: "transactions.memo", hlc: { physical: 8000, counter: 0, deviceId: "d" }, value: "a" },
        ],
      },
    });

    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    const { changes } = response.json() as { changes: { entityId: string; value: unknown }[] };
    const mine = changes.filter((c) => c.entityId === entityId);
    assert.deepEqual(
      mine.map((c) => c.value),
      ["a", "b"],
    );
  });

  it("downloads only changes later than the given since clock", async () => {
    const entityId = randomUUID();
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        changes: [
          { id: randomUUID(), entityId, fieldName: "transactions.memo", hlc: { physical: 10000, counter: 0, deviceId: "d" }, value: "old" },
          { id: randomUUID(), entityId, fieldName: "transactions.memo", hlc: { physical: 11000, counter: 0, deviceId: "d" }, value: "new" },
        ],
      },
    });

    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/changes?sincePhysical=10000&sinceCounter=0&sinceDeviceId=d`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    const { changes } = response.json() as { changes: { entityId: string; value: unknown }[] };
    assert.deepEqual(
      changes.filter((c) => c.entityId === entityId).map((c) => c.value),
      ["new"],
    );
  });

  it("rejects a partial since (not all three of physical/counter/deviceId given)", async () => {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/changes?sincePhysical=1000`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 400);
  });

  it("allows a read-only member to download changes", async () => {
    const readOnlyToken = await tokenFor("read_only");
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    assert.equal(response.statusCode, 200);
  });
});
