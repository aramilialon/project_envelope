/**
 * Money coming back from an off-budget account (#598): the on-budget leg of a transfer from an
 * off-budget account into a cash account may be left without a category, and is then income to
 * assign, or carry a real category. Going out to an off-budget account still needs a category, and
 * so does coming into an on-budget card. These are the domain review's numeric examples, through
 * the routes, with the budget invariant checked after each step: the money in the budget is the
 * money in the on-budget accounts.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { requireIntegrationTestEnv, setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

requireIntegrationTestEnv();

interface Transaction {
  readonly id: string;
  readonly accountId: string;
  readonly status: string;
  readonly splits: readonly { readonly categoryId: string | null; readonly amountCents: number }[];
}

interface Transfer {
  readonly source: Transaction;
  readonly destination: Transaction;
}

interface BudgetMonth {
  readonly unassigned: number;
  readonly assignedInFuture: number;
  readonly creditOverspending: number;
  readonly categories: readonly { readonly categoryId: string; readonly available: number; readonly activity: number }[];
  readonly paymentCategories: readonly { readonly available: number }[];
}

const MONTH = "2026-09";

describe("money coming back from an off-budget account (#598)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  let checkingId: string;
  let brokerId: string;
  let visaId: string;
  const categories: Record<"groceries" | "rent" | "investing" | "holiday", string> = { groceries: "", rent: "", investing: "", holiday: "" };
  /** Example 1's incoming leg, edited in example 4. */
  let sale: Transfer;

  async function request<T>(method: "GET" | "POST" | "PATCH", path: string, payload?: unknown): Promise<{ status: number; body: T }> {
    const response = await app.fastify.inject({
      method,
      url: `/workspaces/${workspaceId}${path}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: response.statusCode, body: response.body === "" ? (undefined as T) : (response.json() as T) };
  }

  async function transactionsOf(accountId: string): Promise<Transaction[]> {
    const listed = await request<{ transactions: Transaction[] }>("GET", `/accounts/${accountId}/transactions`);
    assert.equal(listed.status, 200);
    return listed.body.transactions;
  }

  async function balance(accountId: string): Promise<number> {
    return (await transactionsOf(accountId)).flatMap((t) => t.splits).reduce((sum, s) => sum + s.amountCents, 0);
  }

  async function reread(leg: Transaction): Promise<Transaction | undefined> {
    return (await transactionsOf(leg.accountId)).find((t) => t.id === leg.id);
  }

  async function assign(category: string, amountCents: number): Promise<void> {
    const assigned = await request("POST", "/assignments", {
      entries: [{ month: MONTH, sourceCategoryId: null, destinationCategoryId: category, amountCents }],
    });
    assert.ok(assigned.status < 300, JSON.stringify(assigned.body));
  }

  /** The budget month, after checking its invariant against the on-budget accounts. */
  async function budgetMonth(): Promise<BudgetMonth & { available: (category: string) => number | undefined }> {
    const month = await request<BudgetMonth>("GET", `/budget-months/${MONTH}`);
    assert.equal(month.status, 200, JSON.stringify(month.body));
    const budgeted =
      month.body.unassigned +
      [...month.body.categories, ...month.body.paymentCategories].reduce((sum, c) => sum + c.available, 0) +
      month.body.assignedInFuture +
      month.body.creditOverspending;
    assert.equal(budgeted, await balance(checkingId), "the budget no longer holds the money in the on-budget cash accounts");
    return { ...month.body, available: (category) => month.body.categories.find((c) => c.categoryId === category)?.available };
  }

  function snapshot(month: BudgetMonth): BudgetMonth {
    const { unassigned, assignedInFuture, creditOverspending, categories, paymentCategories } = month;
    return { unassigned, assignedInFuture, creditOverspending, categories, paymentCategories };
  }

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
    const checking = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    checkingId = checking.rows[0]!.id;
    const broker = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Broker', 'brokerage', 'EUR', false) RETURNING id",
      [workspaceId],
    );
    brokerId = broker.rows[0]!.id;
    const visa = await request<{ id: string }>("POST", "/accounts", { name: "Visa", type: "credit_card", currency: "EUR" });
    assert.equal(visa.status, 201, JSON.stringify(visa.body));
    visaId = visa.body.id;
    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Everyday', 1) RETURNING id",
      [workspaceId],
    );
    let order = 0;
    for (const name of Object.keys(categories) as (keyof typeof categories)[]) {
      const { rows } = await superuserPool.query<{ id: string }>(
        "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING id",
        [workspaceId, group.rows[0]!.id, name, ++order],
      );
      categories[name] = rows[0]!.id;
    }

    // September 2026: checking holds €3,000, of which €200 is unassigned, €1,800 in Groceries and
    // €1,000 in Rent; Investing holds nothing.
    const income = await request("POST", `/accounts/${checkingId}/transactions`, {
      occurredAt: `${MONTH}-01`,
      payee: "Salary",
      splits: [{ categoryId: null, amountCents: 300_000 }],
    });
    assert.equal(income.status, 201, JSON.stringify(income.body));
    await assign(categories.groceries, 180_000);
    await assign(categories.rent, 100_000);
  });

  after(async () => {
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  it("starts from the example's month", async () => {
    const month = await budgetMonth();
    assert.equal(month.unassigned, 20_000);
    assert.equal(await balance(checkingId), 300_000);
  });

  it("lands €5,000 from the broker with no category as income to assign (example 1)", async () => {
    const created = await request<Transfer>("POST", "/transfers", {
      sourceAccountId: brokerId,
      destinationAccountId: checkingId,
      occurredAt: `${MONTH}-15`,
      amountCents: 500_000,
      status: "cleared",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    sale = created.body;
    assert.deepEqual(sale.destination.splits.map((s) => [s.categoryId, s.amountCents]), [[null, 500_000]]);
    assert.deepEqual(sale.source.splits.map((s) => [s.categoryId, s.amountCents]), [[null, -500_000]]);

    const month = await budgetMonth();
    assert.equal(month.unassigned, 520_000);
    assert.equal(month.available(categories.groceries), 180_000);
    assert.equal(month.available(categories.rent), 100_000);
    assert.equal(month.available(categories.investing), 0);
    assert.equal(await balance(checkingId), 800_000);
  });

  it("moves the money to Investing when the leg is edited to it, leaving the broker leg alone (example 4)", async () => {
    await assign(categories.holiday, 400_000);
    assert.equal((await budgetMonth()).unassigned, 120_000);
    const brokerLeg = await reread(sale.source);

    const edited = await request<Transaction>("PATCH", `/accounts/${checkingId}/transactions/${sale.destination.id}`, {
      splits: [{ categoryId: categories.investing, amountCents: 500_000 }],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(edited.body.splits.map((s) => [s.categoryId, s.amountCents]), [[categories.investing, 500_000]]);
    assert.equal(edited.body.status, "cleared");

    const month = await budgetMonth();
    assert.equal(month.unassigned, -380_000);
    assert.equal(month.available(categories.investing), 500_000);
    assert.equal(month.available(categories.holiday), 400_000);
    assert.equal(await balance(checkingId), 800_000);
    assert.deepEqual(await reread(sale.source), brokerLeg, "the broker leg, its status too, is untouched");

    // And back to Unassigned.
    const unassigned = await request<Transaction>("PATCH", `/accounts/${checkingId}/transactions/${sale.destination.id}`, {
      splits: [{ categoryId: null, amountCents: 500_000 }],
    });
    assert.equal(unassigned.status, 200, JSON.stringify(unassigned.body));
    assert.equal(unassigned.body.splits[0]!.categoryId, null);
    assert.equal((await budgetMonth()).unassigned, 120_000);
    assert.deepEqual(await reread(sale.source), brokerLeg);
  });

  it("refuses to clear the category of an outgoing leg to the broker or of an incoming leg on a card (example 4's refusals)", async () => {
    const outgoing = await request<Transfer>("POST", "/transfers", {
      sourceAccountId: checkingId,
      destinationAccountId: brokerId,
      occurredAt: `${MONTH}-20`,
      amountCents: 10_000,
      categoryId: categories.investing,
    });
    assert.equal(outgoing.status, 201, JSON.stringify(outgoing.body));
    const refund = await request<Transfer>("POST", "/transfers", {
      sourceAccountId: brokerId,
      destinationAccountId: visaId,
      occurredAt: `${MONTH}-20`,
      amountCents: 2_000,
      categoryId: categories.investing,
    });
    assert.equal(refund.status, 201, JSON.stringify(refund.body));
    const before = await budgetMonth();

    const refusedOutgoing = await request<{ error: string }>("PATCH", `/accounts/${checkingId}/transactions/${outgoing.body.source.id}`, {
      splits: [{ categoryId: null, amountCents: -10_000 }],
    });
    assert.equal(refusedOutgoing.status, 400, JSON.stringify(refusedOutgoing.body));
    assert.equal(refusedOutgoing.body.error, "uncategorized_transaction");

    const refusedCard = await request<{ error: string; details: unknown }>("PATCH", `/accounts/${visaId}/transactions/${refund.body.destination.id}`, {
      splits: [{ categoryId: null, amountCents: 2_000 }],
    });
    assert.equal(refusedCard.status, 400, JSON.stringify(refusedCard.body));
    assert.deepEqual(refusedCard.body, { error: "card_income_not_supported", details: { accountId: visaId } });

    assert.deepEqual(await reread(outgoing.body.source), outgoing.body.source);
    assert.deepEqual(await reread(refund.body.destination), refund.body.destination);
    assert.deepEqual(snapshot(await budgetMonth()), snapshot(before));
  });

  it("refuses a transfer to the broker, or from it into the card, with no category, writing nothing (example 5)", async () => {
    const before = await budgetMonth();
    const [checkingBefore, visaBefore, brokerBefore] = [await transactionsOf(checkingId), await transactionsOf(visaId), await transactionsOf(brokerId)];

    const toBroker = await request<{ error: string }>("POST", "/transfers", {
      sourceAccountId: checkingId,
      destinationAccountId: brokerId,
      occurredAt: `${MONTH}-25`,
      amountCents: 500_000,
    });
    assert.equal(toBroker.status, 400, JSON.stringify(toBroker.body));
    assert.equal(toBroker.body.error, "uncategorized_transaction");

    const intoCard = await request("POST", "/transfers", {
      sourceAccountId: brokerId,
      destinationAccountId: visaId,
      occurredAt: `${MONTH}-25`,
      amountCents: 500_000,
    });
    assert.equal(intoCard.status, 400, JSON.stringify(intoCard.body));
    assert.deepEqual(intoCard.body, { error: "card_income_not_supported", details: { accountId: visaId } });

    assert.deepEqual(await transactionsOf(checkingId), checkingBefore);
    assert.deepEqual(await transactionsOf(visaId), visaBefore);
    assert.deepEqual(await transactionsOf(brokerId), brokerBefore);
    assert.deepEqual(snapshot(await budgetMonth()), snapshot(before));
  });

  it("keeps a real category given to money coming back from the broker as that category's activity (example 2)", async () => {
    const before = await budgetMonth();
    const created = await request<Transfer>("POST", "/transfers", {
      sourceAccountId: brokerId,
      destinationAccountId: checkingId,
      occurredAt: `${MONTH}-26`,
      amountCents: 500_000,
      categoryId: categories.investing,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.destination.splits[0]!.categoryId, categories.investing);

    const month = await budgetMonth();
    assert.equal(month.unassigned, before.unassigned);
    assert.equal(month.available(categories.investing), before.available(categories.investing)! + 500_000);
  });
});
