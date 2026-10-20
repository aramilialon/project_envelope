import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

describe("scheduled transactions routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let accountId: string;
  let categoryId: string;
  let token: string;

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());

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
  });

  after(async () => {
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
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
