import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { requireIntegrationTestEnv, setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

requireIntegrationTestEnv();

interface Split {
  readonly id: string;
  readonly categoryId: string | null;
  readonly amountCents: number;
  readonly memo: string | null;
}

interface Transaction {
  readonly id: string;
  readonly accountId: string;
  readonly occurredAt: string;
  readonly budgetDate: string;
  readonly payee: string | null;
  readonly status: string;
  readonly transferId: string | null;
  readonly splits: readonly Split[];
}

interface Transfer {
  readonly source: Transaction;
  readonly destination: Transaction;
}

const MONTH = "2026-09";

/**
 * Editing the amount of one leg of a transfer edits both (#547): the two legs keep cancelling out,
 * so the money in the budget still matches the money in the on-budget accounts.
 */
describe("editing one leg of a transfer (#547)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  let checkingId: string;
  let savingsId: string;
  let offBudgetId: string;
  let categoryId: string;
  let otherCategoryId: string;

  async function request<T>(method: "GET" | "POST" | "PATCH", path: string, payload?: unknown): Promise<{ status: number; body: T }> {
    const response = await app.fastify.inject({
      method,
      url: `/workspaces/${workspaceId}${path}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: response.statusCode, body: response.body === "" ? (undefined as T) : (response.json() as T) };
  }

  async function account(name: string, onBudget: boolean): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, $2, 'checking', 'EUR', $3) RETURNING id",
      [workspaceId, name, onBudget],
    );
    return rows[0]!.id;
  }

  async function transfer(sourceAccountId: string, destinationAccountId: string, amountCents: number, extra: Record<string, unknown> = {}): Promise<Transfer> {
    const created = await request<Transfer>("POST", "/transfers", {
      sourceAccountId,
      destinationAccountId,
      occurredAt: `${MONTH}-10`,
      amountCents,
      ...extra,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body;
  }

  function patchLeg(leg: Transaction, payload: Record<string, unknown>) {
    return request<Transaction & { error?: string; code?: string }>("PATCH", `/accounts/${leg.accountId}/transactions/${leg.id}`, payload);
  }

  async function reread(leg: Transaction): Promise<Transaction> {
    const listed = await request<{ transactions: Transaction[] }>("GET", `/accounts/${leg.accountId}/transactions`);
    const found = listed.body.transactions.find((t) => t.id === leg.id);
    assert.ok(found, `expected ${leg.id} on its account`);
    return found;
  }

  async function balance(accountId: string): Promise<number> {
    const listed = await request<{ transactions: Transaction[] }>("GET", `/accounts/${accountId}/transactions`);
    return listed.body.transactions.flatMap((t) => t.splits).reduce((sum, s) => sum + s.amountCents, 0);
  }

  function total(leg: Transaction): number {
    return leg.splits.reduce((sum, s) => sum + s.amountCents, 0);
  }

  /** The budget invariant, as the budget-month route computes it: the money in the budget is the money in the on-budget accounts. */
  async function assertBudgetInvariant(): Promise<void> {
    const month = await request<{
      unassigned: number;
      assignedInFuture: number;
      creditOverspending: number;
      categories: readonly { available: number }[];
      paymentCategories: readonly { available: number }[];
    }>("GET", `/budget-months/${MONTH}`);
    assert.equal(month.status, 200, JSON.stringify(month.body));
    const budgeted =
      month.body.unassigned +
      [...month.body.categories, ...month.body.paymentCategories].reduce((sum, c) => sum + c.available, 0) +
      month.body.assignedInFuture +
      month.body.creditOverspending;
    const onBudget = (await balance(checkingId)) + (await balance(savingsId));
    assert.equal(budgeted, onBudget, "the budget no longer holds the money in the on-budget accounts");
  }

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
    checkingId = await account("Checking", true);
    savingsId = await account("Savings", true);
    offBudgetId = await account("Investments", false);
    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const categories = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Savings goal', 1), ($1, $2, 'Groceries', 2) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = categories.rows[0]!.id;
    otherCategoryId = categories.rows[1]!.id;
    const income = await request("POST", `/accounts/${checkingId}/transactions`, {
      occurredAt: `${MONTH}-01`,
      payee: "Salary",
      splits: [{ categoryId: null, amountCents: 300_000 }],
    });
    assert.equal(income.status, 201);
    const assigned = await request("POST", "/assignments", {
      entries: [{ month: MONTH, sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 50_000 }],
    });
    assert.ok(assigned.status < 300, JSON.stringify(assigned.body));
  });

  after(async () => {
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  it("gives the other leg the opposite amount when the source leg's amount changes", async () => {
    const { source, destination } = await transfer(checkingId, savingsId, 5_000);
    const [checkingBefore, savingsBefore] = [await balance(checkingId), await balance(savingsId)];

    const edited = await patchLeg(source, { splits: [{ categoryId: null, amountCents: -8_000 }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(total(edited.body), -8_000);

    const other = await reread(destination);
    assert.equal(total(other), 8_000);
    assert.equal(other.splits.length, 1);
    assert.equal(other.splits[0]!.id, destination.splits[0]!.id, "the other leg keeps its own split");
    assert.equal(other.splits[0]!.categoryId, null);
    assert.equal(await balance(checkingId), checkingBefore - 3_000);
    assert.equal(await balance(savingsId), savingsBefore + 3_000);
    await assertBudgetInvariant();
  });

  it("gives the other leg the opposite amount when the destination leg's amount changes", async () => {
    const { source, destination } = await transfer(checkingId, savingsId, 5_000);

    const edited = await patchLeg(destination, { amountCents: 2_500, splits: [{ categoryId: null, amountCents: 2_500 }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(total(edited.body), 2_500);
    assert.equal(total(await reread(source)), -2_500);
    await assertBudgetInvariant();
  });

  it("keeps the category of the on-budget leg of a transfer to an off-budget account when the off-budget leg changes", async () => {
    const { source, destination } = await transfer(checkingId, offBudgetId, 2_000, { categoryId });

    const edited = await patchLeg(destination, { splits: [{ categoryId: null, amountCents: 3_000 }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    const onBudgetLeg = await reread(source);
    assert.equal(total(onBudgetLeg), -3_000);
    assert.equal(onBudgetLeg.splits.length, 1);
    assert.equal(onBudgetLeg.splits[0]!.categoryId, categoryId, "the on-budget leg keeps its category");
    await assertBudgetInvariant();
  });

  it("keeps the off-budget leg categoryless when the on-budget leg of a transfer to an off-budget account changes", async () => {
    const { source, destination } = await transfer(checkingId, offBudgetId, 2_000, { categoryId });
    const offBudgetBefore = await balance(offBudgetId);

    const edited = await patchLeg(source, { splits: [{ categoryId, amountCents: -4_500 }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.splits[0]!.categoryId, categoryId);

    const offBudgetLeg = await reread(destination);
    assert.equal(total(offBudgetLeg), 4_500);
    assert.equal(offBudgetLeg.splits[0]!.categoryId, null);
    assert.equal(await balance(offBudgetId), offBudgetBefore + 2_500);
    await assertBudgetInvariant();
  });

  it("leaves the other leg alone when only the leg's category changes, not its amount", async () => {
    const { source, destination } = await transfer(checkingId, offBudgetId, 1_200, { categoryId });

    const edited = await patchLeg(source, { splits: [{ categoryId: otherCategoryId, amountCents: -1_200 }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(await reread(destination), destination);
    await assertBudgetInvariant();
  });

  it("sends a cleared other leg back to pending when its amount moves, and keeps each leg's payee its own", async () => {
    const { source, destination } = await transfer(checkingId, savingsId, 1_000, { payee: "Move", status: "cleared" });

    const edited = await patchLeg(source, { payee: "Renamed", splits: [{ categoryId: null, amountCents: -1_100 }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.status, "cleared", "the edited leg keeps the status the request leaves it");
    const other = await reread(destination);
    assert.equal(total(other), 1_100);
    assert.equal(other.payee, "Move");
    assert.equal(other.status, "pending");
    await assertBudgetInvariant();
  });

  it("keeps a cleared other leg cleared when only the leg's category changes", async () => {
    const { source, destination } = await transfer(checkingId, offBudgetId, 1_300, { categoryId, status: "cleared" });

    const edited = await patchLeg(source, { splits: [{ categoryId: otherCategoryId, amountCents: -1_300 }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal((await reread(destination)).status, "cleared");
  });

  // Amounts of the source leg (always negative) of a 500 transfer; "category" stands for a real category id.
  const refusals: readonly (readonly [string, readonly (readonly ["category" | null, number])[], string])[] = [
    ["several splits", [["category", -200], ["category", -300]], "unsupported_transaction"],
    ["a zero amount", [[null, 0]], "invalid_amount"],
    ["a flipped sign", [[null, 500]], "invalid_amount"],
  ];
  for (const [title, splits, code] of refusals) {
    it(`refuses ${title} on a transfer leg with 400 ${code}, changing neither leg`, async () => {
      const { source, destination } = await transfer(checkingId, savingsId, 500);
      const payload = splits.map(([category, amountCents]) => ({ categoryId: category === null ? null : categoryId, amountCents }));

      const refused = await patchLeg(source, { payee: "Changed", splits: payload });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.equal(refused.body.error, code);
      assert.deepEqual(await reread(source), source);
      assert.deepEqual(await reread(destination), destination);
    });
  }

  it("refuses to clear the category of the on-budget leg of a transfer to an off-budget account with 400 uncategorized_transaction (#552)", async () => {
    const { source, destination } = await transfer(checkingId, offBudgetId, 2_500, { categoryId });

    for (const amountCents of [total(source), total(source) * 2]) {
      const refused = await patchLeg(source, { payee: "Changed", splits: [{ categoryId: null, amountCents }] });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.equal(refused.body.error, "uncategorized_transaction");
    }
    assert.deepEqual(await reread(source), source);
    assert.deepEqual(await reread(destination), destination);
    await assertBudgetInvariant();
  });

  it("lets the category of the on-budget leg of a transfer from an off-budget account be cleared, as income to assign (#598)", async () => {
    const { source, destination } = await transfer(offBudgetId, checkingId, 2_500, { categoryId });

    const cleared = await patchLeg(destination, { splits: [{ categoryId: null, amountCents: 4_000 }] });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.deepEqual(cleared.body.splits.map((s) => [s.categoryId, s.amountCents]), [[null, 4_000]]);
    const other = await reread(source);
    assert.equal(total(other), -4_000);
    assert.equal(other.splits[0]!.categoryId, null);
    await assertBudgetInvariant();
  });

  it("ignores a category sent on a leg of a transfer between two on-budget accounts, as creating it does (#552)", async () => {
    const { source, destination } = await transfer(checkingId, savingsId, 800, { categoryId });
    assert.equal(source.splits[0]!.categoryId, null, "creating the transfer ignores the category");

    const edited = await patchLeg(source, { splits: [{ categoryId: otherCategoryId, amountCents: -1_000 }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.splits[0]!.categoryId, null);
    assert.equal(total(edited.body), -1_000);
    const other = await reread(destination);
    assert.equal(other.splits[0]!.categoryId, null);
    assert.equal(total(other), 1_000);

    const sameAmount = await patchLeg(destination, { splits: [{ categoryId, amountCents: 1_000 }] });
    assert.equal(sameAmount.status, 200, JSON.stringify(sameAmount.body));
    assert.equal(sameAmount.body.splits[0]!.categoryId, null);
    await assertBudgetInvariant();
  });

  it("refuses with 409 when the other leg is reconciled, and changes neither leg", async () => {
    const { source, destination } = await transfer(checkingId, savingsId, 750);
    await superuserPool.query("UPDATE transactions SET status = 'reconciled' WHERE id = $1", [destination.id]);
    const reconciled = await reread(destination);

    const refused = await patchLeg(source, { payee: "Changed", splits: [{ categoryId: null, amountCents: -900 }] });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.deepEqual(await reread(source), source);
    assert.deepEqual(await reread(destination), reconciled);
    await assertBudgetInvariant();
  });

  it("refuses with 409 when the edited leg itself is reconciled", async () => {
    const { source, destination } = await transfer(checkingId, savingsId, 640);
    await superuserPool.query("UPDATE transactions SET status = 'reconciled' WHERE id = $1", [source.id]);

    const refused = await patchLeg(source, { splits: [{ categoryId: null, amountCents: -900 }] });
    assert.equal(refused.status, 409);
    assert.deepEqual(await reread(destination), destination);
  });

  it("refuses an edit whose new splits do not match the given amount, changing neither leg", async () => {
    const { source, destination } = await transfer(checkingId, savingsId, 300);

    const refused = await patchLeg(source, { amountCents: -500, splits: [{ categoryId: null, amountCents: -400 }] });
    assert.equal(refused.status, 400);
    assert.deepEqual(await reread(source), source);
    assert.deepEqual(await reread(destination), destination);
  });

  it("still refuses a change to the amount of a trade's cash leg", async () => {
    const broker = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Broker', 'brokerage', 'EUR', false) RETURNING id",
      [workspaceId],
    );
    const portfolio = await superuserPool.query<{ id: string }>("INSERT INTO portfolios (workspace_id, name) VALUES ($1, 'Growth') RETURNING id", [
      workspaceId,
    ]);
    const trade = await request<{ trades: { cashTransactionId: string }[] }>("POST", "/trades", {
      type: "fee",
      accountId: broker.rows[0]!.id,
      portfolioId: portfolio.rows[0]!.id,
      tradeDate: `${MONTH}-12`,
      feesCents: 700,
    });
    assert.equal(trade.status, 201, JSON.stringify(trade.body));
    const legId = trade.body.trades[0]!.cashTransactionId;

    const refused = await request<{ code: string }>("PATCH", `/accounts/${broker.rows[0]!.id}/transactions/${legId}`, {
      splits: [{ categoryId: null, amountCents: -1 }],
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "trade_owned_transaction");
    assert.equal(await balance(broker.rows[0]!.id), -700);
  });

  describe("a new amount alone, or a new date (#655)", () => {
    it("gives the other leg the opposite amount when amountCents alone changes one leg", async () => {
      const { source, destination } = await transfer(checkingId, savingsId, 5_000);

      const edited = await patchLeg(source, { amountCents: -6_500 });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(total(edited.body), -6_500);
      assert.equal(edited.body.splits[0]!.id, source.splits[0]!.id, "the leg's one split is rewritten in place");
      const other = await reread(destination);
      assert.equal(total(other), 6_500);
      assert.equal(other.splits[0]!.id, destination.splits[0]!.id);
      await assertBudgetInvariant();
    });

    it("keeps the category of the on-budget leg of a transfer to an off-budget account when amountCents alone changes it", async () => {
      const { source, destination } = await transfer(checkingId, offBudgetId, 1_000, { categoryId });

      const edited = await patchLeg(source, { amountCents: -1_200 });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(edited.body.splits[0]!.categoryId, categoryId);
      assert.equal(total(await reread(destination)), 1_200);
      await assertBudgetInvariant();
    });

    it("refuses a new amount alone that would flip the leg's direction, changing neither leg", async () => {
      const { source, destination } = await transfer(checkingId, savingsId, 900);

      const refused = await patchLeg(source, { amountCents: 900 });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.equal(refused.body.error, "invalid_amount");
      assert.deepEqual(await reread(source), source);
      assert.deepEqual(await reread(destination), destination);
    });

    it("moves both legs to the new date, sends a cleared other leg back to pending, and keeps the budget whole", async () => {
      const { source, destination } = await transfer(checkingId, savingsId, 2_200, { status: "cleared" });

      const edited = await patchLeg(destination, { occurredAt: `${MONTH}-25` });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(edited.body.budgetDate, `${MONTH}-25`);
      assert.equal(edited.body.status, "cleared", "the edited leg keeps its own status");
      const other = await reread(source);
      assert.equal(other.budgetDate, `${MONTH}-25`);
      assert.equal(other.occurredAt, edited.body.occurredAt);
      assert.equal(other.status, "pending");
      assert.equal(total(other), -2_200);
      await assertBudgetInvariant();
    });

    it("moves both legs of a transfer to an off-budget account, its category with them, keeping the budget whole", async () => {
      const { source, destination } = await transfer(checkingId, offBudgetId, 1_500, { categoryId });

      const edited = await patchLeg(source, { occurredAt: `${MONTH}-03` });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(edited.body.splits[0]!.categoryId, categoryId);
      assert.equal((await reread(destination)).budgetDate, `${MONTH}-03`);
      await assertBudgetInvariant();
    });

    it("leaves a cleared other leg alone when the date sent is the one both legs already have", async () => {
      const { source, destination } = await transfer(checkingId, savingsId, 330, { status: "cleared" });

      const edited = await patchLeg(source, { occurredAt: `${MONTH}-10`, memo: "Same day" });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.deepEqual(await reread(destination), destination);
    });

    it("refuses a new date with 409 when the other leg is reconciled, and moves neither leg", async () => {
      const { source, destination } = await transfer(checkingId, savingsId, 410);
      await superuserPool.query("UPDATE transactions SET status = 'reconciled' WHERE id = $1", [destination.id]);
      const reconciled = await reread(destination);

      const refused = await patchLeg(source, { occurredAt: `${MONTH}-20` });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.deepEqual(await reread(source), source);
      assert.deepEqual(await reread(destination), reconciled);
    });

    it("refuses a new date for a trade's cash leg with 409 trade_owned_transaction", async () => {
      const broker = await superuserPool.query<{ id: string }>(
        "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Broker 655', 'brokerage', 'EUR', false) RETURNING id",
        [workspaceId],
      );
      const portfolio = await superuserPool.query<{ id: string }>("INSERT INTO portfolios (workspace_id, name) VALUES ($1, 'Income 655') RETURNING id", [
        workspaceId,
      ]);
      const trade = await request<{ trades: { cashTransactionId: string }[] }>("POST", "/trades", {
        type: "fee",
        accountId: broker.rows[0]!.id,
        portfolioId: portfolio.rows[0]!.id,
        tradeDate: `${MONTH}-12`,
        feesCents: 300,
      });
      assert.equal(trade.status, 201, JSON.stringify(trade.body));
      const path = `/accounts/${broker.rows[0]!.id}/transactions/${trade.body.trades[0]!.cashTransactionId}`;

      for (const payload of [{ occurredAt: `${MONTH}-13` }, { amountCents: -1 }]) {
        const refused = await request<{ code: string }>("PATCH", path, payload);
        assert.equal(refused.status, 409, JSON.stringify(payload));
        assert.equal(refused.body.code, "trade_owned_transaction");
      }
      // Its own date sent back changes nothing the trade owns: the memo edit goes through.
      const memo = await request<Transaction & { budgetDate: string }>("PATCH", path, { occurredAt: `${MONTH}-12`, memo: "Custody fee" });
      assert.equal(memo.status, 200, JSON.stringify(memo.body));
      assert.equal(memo.body.budgetDate, `${MONTH}-12`);
    });
  });

  it("refuses a synced change to a transfer leg's amount as unsupported, changing neither leg", async () => {
    const { source, destination } = await transfer(checkingId, savingsId, 420);

    const uploaded = await request<{ results: { outcome: string }[] }>("POST", "/changes", {
      changes: [
        {
          id: randomUUID(),
          entityId: source.splits[0]!.id,
          fieldName: "splits.amount_cents",
          hlc: { physical: Date.now(), counter: 0, deviceId: "phone" },
          value: -999,
        },
      ],
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.deepEqual(
      uploaded.body.results.map((result) => result.outcome),
      ["unsupported_field"],
    );
    assert.deepEqual(await reread(source), source);
    assert.deepEqual(await reread(destination), destination);
  });

  it("refuses a synced change to a transfer leg's category as unsupported, changing neither leg (#552)", async () => {
    const { source, destination } = await transfer(checkingId, offBudgetId, 610, { categoryId });

    const uploaded = await request<{ results: { outcome: string }[] }>("POST", "/changes", {
      changes: [
        {
          id: randomUUID(),
          entityId: source.splits[0]!.id,
          fieldName: "splits.category_id",
          hlc: { physical: Date.now(), counter: 0, deviceId: "phone" },
          value: null,
        },
      ],
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.deepEqual(
      uploaded.body.results.map((result) => result.outcome),
      ["unsupported_field"],
    );
    assert.deepEqual(await reread(source), source);
    assert.deepEqual(await reread(destination), destination);
    await assertBudgetInvariant();
  });
});
