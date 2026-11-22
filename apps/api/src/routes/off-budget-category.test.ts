/**
 * A transaction on an off-budget account, other than a transfer leg, carries no category (#710):
 * the budget never counts money there, so a category stored on it would only say something the
 * budget ignores. Every write path that can put a category on such a split refuses it with
 * 400 `category_not_allowed` and `details.field` "categoryId", writing nothing; a transfer keeps
 * its own rule (the on-budget leg carries the category, the off-budget leg never does).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

describe("a category on a transaction of an off-budget account (#710)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  let offBudgetId: string;
  let checkingId: string;
  let categoryId: string;
  let auth: { authorization: string };

  const REFUSAL = { error: "category_not_allowed", details: { field: "categoryId" } };

  async function transactionCount(accountId: string): Promise<number> {
    const { rows } = await superuserPool.query<{ count: string }>(
      "SELECT count(*) FROM transactions WHERE workspace_id = $1 AND account_id = $2",
      [workspaceId, accountId],
    );
    return Number(rows[0]!.count);
  }

  async function splitsOf(transactionId: string): Promise<[string | null, number][]> {
    const { rows } = await superuserPool.query<{ category_id: string | null; amount_cents: string }>(
      "SELECT category_id, amount_cents FROM splits WHERE transaction_id = $1 ORDER BY amount_cents",
      [transactionId],
    );
    return rows.map((r) => [r.category_id, Number(r.amount_cents)]);
  }

  async function create(accountId: string, splits: { categoryId: string | null; amountCents: number }[]) {
    return app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-10", splits },
    });
  }

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
    auth = { authorization: `Bearer ${token}` };

    const offBudget = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Mortgage', 'savings', 'EUR', false) RETURNING id",
      [workspaceId],
    );
    offBudgetId = offBudget.rows[0]!.id;
    const checking = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    checkingId = checking.rows[0]!.id;
    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;
  });

  after(async () => {
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  it("refuses creating an outflow or an inflow with a category, writing nothing", async () => {
    const before = await transactionCount(offBudgetId);
    for (const amountCents of [-2500, 2500]) {
      const response = await create(offBudgetId, [{ categoryId, amountCents }]);
      assert.equal(response.statusCode, 400, response.body);
      assert.deepEqual(response.json(), REFUSAL);
    }
    assert.equal(await transactionCount(offBudgetId), before);
  });

  it("answers category_not_allowed, not the split rule, for several splits where one has a category", async () => {
    const response = await create(offBudgetId, [
      { categoryId, amountCents: -1000 },
      { categoryId: null, amountCents: -500 },
    ]);
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json(), REFUSAL);
  });

  it("accepts an outflow and an inflow without a category, and a categorized outflow on an on-budget account", async () => {
    for (const amountCents of [-2500, 2500]) {
      const response = await create(offBudgetId, [{ categoryId: null, amountCents }]);
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.json().splits[0].categoryId, null);
    }
    const onBudget = await create(checkingId, [{ categoryId, amountCents: -2500 }]);
    assert.equal(onBudget.statusCode, 201, onBudget.body);
  });

  it("refuses an edit that gives a split a category, leaving the splits and the memo as they were", async () => {
    const created = await create(offBudgetId, [{ categoryId: null, amountCents: -3000 }]);
    assert.equal(created.statusCode, 201, created.body);
    const transactionId = created.json().id as string;

    const refused = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${offBudgetId}/transactions/${transactionId}`,
      headers: auth,
      payload: { memo: "edited", splits: [{ categoryId, amountCents: -3000 }] },
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.deepEqual(refused.json(), REFUSAL);
    assert.deepEqual(await splitsOf(transactionId), [[null, -3000]]);
    const { rows } = await superuserPool.query<{ memo: string | null }>("SELECT memo FROM transactions WHERE id = $1", [transactionId]);
    assert.equal(rows[0]!.memo, null);

    const accepted = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${offBudgetId}/transactions/${transactionId}`,
      headers: auth,
      payload: { splits: [{ categoryId: null, amountCents: -3200 }] },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(await splitsOf(transactionId), [[null, -3200]]);
  });

  it("lets a row stored with a category before #710 be edited: a new amount alone keeps it, new splits must drop it", async () => {
    // Stored directly: the API no longer accepts it, but a database from before #710 may hold one.
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO transactions (workspace_id, account_id, occurred_at, status) VALUES ($1, $2, '2026-09-12', 'pending') RETURNING id",
      [workspaceId, offBudgetId],
    );
    const transactionId = rows[0]!.id;
    await superuserPool.query("INSERT INTO splits (workspace_id, transaction_id, category_id, amount_cents) VALUES ($1, $2, $3, -900)", [
      workspaceId,
      transactionId,
      categoryId,
    ]);
    const url = `/workspaces/${workspaceId}/accounts/${offBudgetId}/transactions/${transactionId}`;

    const memo = await app.fastify.inject({ method: "PATCH", url, headers: auth, payload: { memo: "kept" } });
    assert.equal(memo.statusCode, 200, memo.body);
    const amount = await app.fastify.inject({ method: "PATCH", url, headers: auth, payload: { amountCents: -950 } });
    assert.equal(amount.statusCode, 200, amount.body);
    assert.deepEqual(await splitsOf(transactionId), [[categoryId, -950]]);

    const sameCategory = await app.fastify.inject({ method: "PATCH", url, headers: auth, payload: { splits: [{ categoryId, amountCents: -950 }] } });
    assert.equal(sameCategory.statusCode, 400, sameCategory.body);
    assert.deepEqual(sameCategory.json(), REFUSAL);
    const cleared = await app.fastify.inject({ method: "PATCH", url, headers: auth, payload: { splits: [{ categoryId: null, amountCents: -950 }] } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.deepEqual(await splitsOf(transactionId), [[null, -950]]);
  });

  it("leaves transfers to their own rule: the on-budget leg keeps its category, the off-budget leg ignores one", async () => {
    const transfer = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/transfers`,
      headers: auth,
      payload: { sourceAccountId: checkingId, destinationAccountId: offBudgetId, occurredAt: "2026-09-14", amountCents: 4000, categoryId },
    });
    assert.equal(transfer.statusCode, 201, transfer.body);
    const { source, destination } = transfer.json() as { source: { id: string }; destination: { id: string } };
    assert.deepEqual(await splitsOf(source.id), [[categoryId, -4000]]);
    assert.deepEqual(await splitsOf(destination.id), [[null, 4000]]);

    const offBudgetLeg = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${offBudgetId}/transactions/${destination.id}`,
      headers: auth,
      payload: { splits: [{ categoryId, amountCents: 4000 }] },
    });
    assert.equal(offBudgetLeg.statusCode, 200, offBudgetLeg.body);
    assert.deepEqual(await splitsOf(destination.id), [[null, 4000]]);

    const onBudgetLeg = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${checkingId}/transactions/${source.id}`,
      headers: auth,
      payload: { splits: [{ categoryId, amountCents: -4500 }] },
    });
    assert.equal(onBudgetLeg.statusCode, 200, onBudgetLeg.body);
    assert.deepEqual(await splitsOf(source.id), [[categoryId, -4500]]);
    assert.deepEqual(await splitsOf(destination.id), [[null, 4500]]);
  });

  it("rejects an import row confirmed with a category, leaving it staged, and confirms one without", async () => {
    const content =
      "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>" +
      "<STMTTRN><DTPOSTED>20260915000000<TRNAMT>-12.00<FITID>OFF-710-1<NAME>Insurance</STMTTRN>" +
      "<STMTTRN><DTPOSTED>20260915000000<TRNAMT>-8.00<FITID>OFF-710-2<NAME>Fee</STMTTRN>" +
      "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";
    const staged = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${offBudgetId}/import`,
      headers: auth,
      payload: { content, format: "ofx" },
    });
    assert.equal(staged.statusCode, 201, staged.body);
    const rows = staged.json().staged as { id: string; amountCents: number }[];
    const categorized = rows.find((r) => r.amountCents === -1200)!;
    const plain = rows.find((r) => r.amountCents === -800)!;
    const before = await transactionCount(offBudgetId);

    const confirmed = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${offBudgetId}/staged-transactions/confirm`,
      headers: auth,
      payload: {
        decisions: [
          { stagedTransactionId: categorized.id, kind: "category", categoryId },
          { stagedTransactionId: plain.id, kind: "income" },
        ],
      },
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    const outcomes = confirmed.json().outcomes as { stagedTransactionId: string; outcome: string; code?: string }[];
    assert.deepEqual(outcomes.find((o) => o.stagedTransactionId === categorized.id), {
      stagedTransactionId: categorized.id,
      outcome: "rejected",
      code: "category_not_allowed",
    });
    assert.equal(outcomes.find((o) => o.stagedTransactionId === plain.id)?.outcome, "confirmed");
    assert.equal(await transactionCount(offBudgetId), before + 1);

    const stillStaged = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${offBudgetId}/staged-transactions`,
      headers: auth,
    });
    assert.deepEqual(
      (stillStaged.json().staged as { id: string }[]).map((r) => r.id),
      [categorized.id],
    );
  });

  it("refuses a reconciliation adjustment with a category, writing nothing", async () => {
    const before = await transactionCount(offBudgetId);
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${offBudgetId}/reconciliations`,
      headers: auth,
      payload: { date: "2026-09-30", statementBalanceCents: 99_999, tickedTransactionIds: [], adjustment: { categoryId } },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json(), REFUSAL);
    assert.equal(await transactionCount(offBudgetId), before);
    const { rows } = await superuserPool.query("SELECT 1 FROM reconciliations WHERE account_id = $1", [offBudgetId]);
    assert.equal(rows.length, 0);
  });

  it("gives sync uploads no field that could put a category on a split (existing behaviour, guarded)", async () => {
    const created = await create(offBudgetId, [{ categoryId: null, amountCents: -600 }]);
    assert.equal(created.statusCode, 201, created.body);
    const transactionId = created.json().id as string;
    const split = (await superuserPool.query<{ id: string }>("SELECT id FROM splits WHERE transaction_id = $1", [transactionId])).rows[0]!;
    const hlc = { physical: Date.now(), counter: 0, deviceId: "device-710" };

    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: auth,
      payload: { changes: [{ id: randomUUID(), entityId: split.id, fieldName: "splits.category_id", hlc, value: categoryId }] },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(
      (response.json().results as { outcome: string }[]).map((r) => r.outcome),
      ["unsupported_field"],
    );
    assert.deepEqual(await splitsOf(transactionId), [[null, -600]]);
  });

  it("still records a scheduled outflow on the account as scheduled, its category included", async () => {
    // A scheduled outflow is told from scheduled income by its category; recording one is left as it was (#710's report).
    const scheduled = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions`,
      headers: auth,
      payload: { accountId: offBudgetId, nextDueDate: "2026-09-20", recurEvery: 1, recurUnit: "month", splits: [{ categoryId, amountCents: 700 }] },
    });
    assert.equal(scheduled.statusCode, 201, scheduled.body);
    const recorded = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions/${scheduled.json().id as string}/record`,
      headers: auth,
    });
    assert.equal(recorded.statusCode, 201, recorded.body);
    assert.deepEqual(await splitsOf(recorded.json().transaction.id as string), [[categoryId, -700]]);
  });
});
