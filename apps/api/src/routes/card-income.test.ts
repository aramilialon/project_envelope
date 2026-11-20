/**
 * Income on an on-budget credit card is refused on every write path (#548): `@envelope/core`
 * does not model it yet, and one stored row would make every budget-month read of the workspace
 * fail with `unsupported_transaction`. Each test checks the refusal, that nothing was written,
 * and that the budget month still reads; a categorized inflow (a merchant refund) stays allowed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { fireDueScheduledTransactions } from "../scheduled-transactions/repository.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

describe("income on an on-budget credit card (#548)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  let cardId: string;
  let offBudgetCardId: string;
  let checkingId: string;
  let categoryId: string;
  let auth: { authorization: string };

  async function cardTransactionCount(): Promise<number> {
    const { rows } = await superuserPool.query<{ count: string }>(
      "SELECT count(*) FROM transactions WHERE workspace_id = $1 AND account_id = $2",
      [workspaceId, cardId],
    );
    return Number(rows[0]!.count);
  }

  async function assertBudgetMonthReads(): Promise<void> {
    const response = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/budget-months/2026-09`, headers: auth });
    assert.equal(response.statusCode, 200, response.body);
  }

  function assertRefused(response: { statusCode: number; json: () => unknown }): void {
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "card_income_not_supported", details: { accountId: cardId } });
  }

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
    auth = { authorization: `Bearer ${token}` };

    const card = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: auth,
      payload: { name: "Visa", type: "credit_card", currency: "EUR" },
    });
    assert.equal(card.statusCode, 201);
    cardId = card.json().id as string;
    const offBudgetCard = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Store card', 'credit_card', 'EUR', false) RETURNING id",
      [workspaceId],
    );
    offBudgetCardId = offBudgetCard.rows[0]!.id;
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

  it("refuses creating an uncategorized inflow on the card, writing nothing", async () => {
    const before = await cardTransactionCount();
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${cardId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-10", payee: "Cashback", splits: [{ categoryId: null, amountCents: 500 }] },
    });
    assertRefused(response);
    assert.equal(await cardTransactionCount(), before);
    await assertBudgetMonthReads();
  });

  it("refuses an uncategorized outflow on the card too: the core refuses both signs", async () => {
    const before = await cardTransactionCount();
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${cardId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-10", splits: [{ categoryId: null, amountCents: -500 }] },
    });
    assertRefused(response);
    assert.equal(await cardTransactionCount(), before);
  });

  it("accepts a categorized inflow on the card (a merchant refund) and the budget month still reads", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${cardId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-11", payee: "Store refund", splits: [{ categoryId, amountCents: 1500 }] },
    });
    assert.equal(response.statusCode, 201, response.body);
    await assertBudgetMonthReads();
  });

  it("accepts income on an off-budget card and on a cash account", async () => {
    for (const accountId of [offBudgetCardId, checkingId]) {
      const response = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
        headers: auth,
        payload: { occurredAt: "2026-09-12", splits: [{ categoryId: null, amountCents: 700 }] },
      });
      assert.equal(response.statusCode, 201, response.body);
    }
    await assertBudgetMonthReads();
  });

  it("refuses editing a card transaction into income, leaving its splits as they were", async () => {
    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${cardId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-13", splits: [{ categoryId, amountCents: -2500 }] },
    });
    assert.equal(created.statusCode, 201);
    const transactionId = created.json().id as string;

    const response = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${cardId}/transactions/${transactionId}`,
      headers: auth,
      payload: { memo: "edited", splits: [{ categoryId: null, amountCents: 2500 }] },
    });
    assertRefused(response);
    const { rows } = await superuserPool.query<{ category_id: string | null; amount_cents: string; memo: string | null }>(
      "SELECT s.category_id, s.amount_cents, t.memo FROM splits s JOIN transactions t ON t.id = s.transaction_id WHERE t.id = $1",
      [transactionId],
    );
    assert.deepEqual(
      rows.map((r) => [r.category_id, Number(r.amount_cents), r.memo]),
      [[categoryId, -2500, null]],
    );
    await assertBudgetMonthReads();
  });

  it("still accepts a card payment (a transfer into the card, with no category)", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/transfers`,
      headers: auth,
      payload: { sourceAccountId: checkingId, destinationAccountId: cardId, occurredAt: "2026-09-14", amountCents: 1000 },
    });
    assert.equal(response.statusCode, 201, response.body);
    await assertBudgetMonthReads();
  });

  it("rejects an import row confirmed as income on the card, leaving it staged", async () => {
    const content =
      "<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>" +
      "<STMTTRN><DTPOSTED>20260915000000<TRNAMT>12.00<FITID>CARD-INCOME-1<NAME>Cashback</STMTTRN>" +
      "<STMTTRN><DTPOSTED>20260915000000<TRNAMT>8.00<FITID>CARD-REFUND-1<NAME>Store refund</STMTTRN>" +
      "</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>";
    const staged = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${cardId}/import`,
      headers: auth,
      payload: { content, format: "ofx" },
    });
    assert.equal(staged.statusCode, 201, staged.body);
    const rows = staged.json().staged as { id: string; amountCents: number }[];
    const income = rows.find((r) => r.amountCents === 1200)!;
    const refund = rows.find((r) => r.amountCents === 800)!;
    const before = await cardTransactionCount();

    const confirmed = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${cardId}/staged-transactions/confirm`,
      headers: auth,
      payload: {
        decisions: [
          { stagedTransactionId: income.id, kind: "income" },
          { stagedTransactionId: refund.id, kind: "category", categoryId },
        ],
      },
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    const outcomes = confirmed.json().outcomes as { stagedTransactionId: string; outcome: string; code?: string }[];
    assert.deepEqual(outcomes.find((o) => o.stagedTransactionId === income.id), {
      stagedTransactionId: income.id,
      outcome: "rejected",
      code: "card_income_not_supported",
    });
    assert.equal(outcomes.find((o) => o.stagedTransactionId === refund.id)?.outcome, "confirmed");
    assert.equal(await cardTransactionCount(), before + 1);

    const stillStaged = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${cardId}/staged-transactions`,
      headers: auth,
    });
    assert.deepEqual(
      (stillStaged.json().staged as { id: string }[]).map((r) => r.id),
      [income.id],
    );
    await assertBudgetMonthReads();
  });

  it("refuses a reconciliation adjustment with no category on the card, writing nothing", async () => {
    const before = await cardTransactionCount();
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${cardId}/reconciliations`,
      headers: auth,
      payload: { date: "2026-09-30", statementBalanceCents: 99_999, tickedTransactionIds: [], adjustment: { categoryId: null } },
    });
    assertRefused(response);
    assert.equal(await cardTransactionCount(), before);
    const { rows } = await superuserPool.query("SELECT 1 FROM reconciliations WHERE account_id = $1", [cardId]);
    assert.equal(rows.length, 0);
    await assertBudgetMonthReads();
  });

  it("refuses defining scheduled income on the card, and editing a scheduled expense into income", async () => {
    const countScheduled = async () =>
      Number(
        (await superuserPool.query<{ count: string }>("SELECT count(*) FROM scheduled_transactions WHERE account_id = $1", [cardId])).rows[0]!
          .count,
      );
    const before = await countScheduled();
    const refused = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions`,
      headers: auth,
      payload: { accountId: cardId, nextDueDate: "2026-09-20", recurEvery: 1, recurUnit: "month", splits: [{ categoryId: null, amountCents: 500 }] },
    });
    assertRefused(refused);
    assert.equal(await countScheduled(), before);

    const expense = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions`,
      headers: auth,
      payload: { accountId: cardId, nextDueDate: "2026-09-20", recurEvery: 1, recurUnit: "month", splits: [{ categoryId, amountCents: 900 }] },
    });
    assert.equal(expense.statusCode, 201, expense.body);
    const scheduledId = expense.json().id as string;
    const edited = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/scheduled-transactions/${scheduledId}`,
      headers: auth,
      payload: { payee: "Cashback", splits: [{ categoryId: null, amountCents: 900 }] },
    });
    assertRefused(edited);
    const { rows } = await superuserPool.query<{ category_id: string | null }>(
      "SELECT category_id FROM scheduled_transaction_splits WHERE scheduled_transaction_id = $1",
      [scheduledId],
    );
    assert.deepEqual(
      rows.map((r) => r.category_id),
      [categoryId],
    );
    await superuserPool.query("DELETE FROM scheduled_transactions WHERE id = $1", [scheduledId]);
    await assertBudgetMonthReads();
  });

  it("refuses recording scheduled income on the card stored before #548, and the job skips it while firing the others", async () => {
    // Stored directly: the API no longer accepts it, but a database from before #548 may hold one.
    const insertScheduled = async (accountId: string, splitCategoryId: string | null) => {
      const { rows } = await superuserPool.query<{ id: string }>(
        `INSERT INTO scheduled_transactions (workspace_id, account_id, next_due_date, recur_every, recur_unit)
         VALUES ($1, $2, '2026-09-05', 1, 'month') RETURNING id`,
        [workspaceId, accountId],
      );
      const id = rows[0]!.id;
      await superuserPool.query(
        "INSERT INTO scheduled_transaction_splits (workspace_id, scheduled_transaction_id, category_id, amount_cents) VALUES ($1, $2, $3, 400)",
        [workspaceId, id, splitCategoryId],
      );
      return id;
    };
    const legacyId = await insertScheduled(cardId, null);
    const before = await cardTransactionCount();

    const recorded = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/scheduled-transactions/${legacyId}/record`,
      headers: auth,
    });
    assertRefused(recorded);
    assert.equal(await cardTransactionCount(), before);

    const expenseId = await insertScheduled(cardId, categoryId);
    const results = await fireDueScheduledTransactions(superuserPool, workspaceId, "2026-09-06");
    assert.deepEqual(
      results.map((r) => r.scheduledTransaction.id),
      [expenseId],
    );
    assert.equal(await cardTransactionCount(), before + 1);
    const { rows } = await superuserPool.query<{ next_due_date: string }>(
      "SELECT to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date FROM scheduled_transactions WHERE id = $1",
      [legacyId],
    );
    assert.equal(rows[0]!.next_due_date, "2026-09-05");
    await superuserPool.query("DELETE FROM scheduled_transactions WHERE id = ANY($1)", [[legacyId, expenseId]]);
    await assertBudgetMonthReads();
  });

  it("gives sync uploads no field that could turn a card transaction into income (existing behaviour, guarded)", async () => {
    const refundResponse = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${cardId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-16", payee: "Sync test refund", splits: [{ categoryId, amountCents: 700 }] },
    });
    assert.equal(refundResponse.statusCode, 201, refundResponse.body);
    const refundTransactionId = refundResponse.json().id as string;
    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${checkingId}/transactions`,
      headers: auth,
      payload: { occurredAt: "2026-09-16", splits: [{ categoryId: null, amountCents: 300 }] },
    });
    assert.equal(created.statusCode, 201);
    const income = created.json() as { id: string };
    const refund = (
      await superuserPool.query<{ id: string }>(
        "SELECT id FROM splits WHERE transaction_id = $1",
        [refundTransactionId],
      )
    ).rows[0]!;
    const hlc = { physical: Date.now(), counter: 0, deviceId: "device-548" };

    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: auth,
      payload: {
        changes: [
          { id: randomUUID(), entityId: income.id, fieldName: "transactions.account_id", hlc, value: cardId },
          { id: randomUUID(), entityId: refund.id, fieldName: "splits.category_id", hlc, value: null },
        ],
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(
      (response.json().results as { outcome: string }[]).map((r) => r.outcome),
      ["unsupported_field", "unsupported_field"],
    );
    const { rows } = await superuserPool.query<{ account_id: string }>("SELECT account_id FROM transactions WHERE id = $1", [income.id]);
    assert.equal(rows[0]!.account_id, checkingId);
    await assertBudgetMonthReads();
  });
});
