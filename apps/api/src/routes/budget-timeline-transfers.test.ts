import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

/**
 * The budget month's own timeline counts the net movement of every on-budget account, cards
 * included (#659): a transfer between two on-budget accounts (a card payment, cash to cash, card to
 * card) counts at neither end, one with an off-budget account counts once, and a card's starting
 * balance does not count. Each test uses a month of its own in a workspace of its own, so its
 * events are exactly the ones it records.
 */
describe("budget month events: transfers and cards on the workspace timeline (#659)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  let checkingId: string;
  let savingsId: string;
  let visaId: string;
  let mastercardId: string;
  let brokerId: string;
  let groceriesId: string;
  let investingId: string;

  const auth = () => ({ authorization: `Bearer ${token}` });

  async function post(url: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await app.fastify.inject({ method: "POST", url: `/workspaces/${workspaceId}${url}`, headers: auth(), payload });
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${url}: ${response.statusCode} ${response.body}`);
    return response.json() as Record<string, unknown>;
  }

  async function account(name: string, type: string, onBudget: boolean, startingBalanceCents?: number): Promise<string> {
    const created = await post("/accounts", {
      name,
      type,
      currency: "EUR",
      onBudget,
      ...(startingBalanceCents === undefined ? {} : { startingBalanceCents }),
    });
    return created.id as string;
  }

  async function events(month: string): Promise<Array<{ date: string; amountCents: number }>> {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/budget-months/${month}/events`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 200);
    return (response.json().events as Array<{ date: string; amountCents: number; kind: string }>).filter((e) => e.kind !== "scheduled");
  }

  function runningTotals(list: ReadonlyArray<{ amountCents: number }>): number[] {
    let total = 0;
    return list.map((e) => (total += e.amountCents));
  }

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Everyday', 1) RETURNING id",
      [workspaceId],
    );
    const categories = await superuserPool.query<{ id: string; name: string }>(
      `INSERT INTO categories (workspace_id, group_id, name, sort_order)
       VALUES ($1, $2, 'Groceries', 1), ($1, $2, 'Investing', 2) RETURNING id, name`,
      [workspaceId, group.rows[0]!.id],
    );
    groceriesId = categories.rows.find((c) => c.name === "Groceries")!.id;
    investingId = categories.rows.find((c) => c.name === "Investing")!.id;

    checkingId = await account("Checking", "checking", true);
    savingsId = await account("Savings", "savings", true);
    visaId = await account("Visa", "credit_card", true);
    mastercardId = await account("Mastercard", "credit_card", true, -84_500);
    brokerId = await account("Broker", "savings", false);
    // The starting balance is dated the day the card was added; move it into the month under test.
    await superuserPool.query(
      "UPDATE transactions SET occurred_at = '2027-02-01T12:00:00Z' WHERE workspace_id = $1 AND account_id = $2 AND payee = 'Starting balance'",
      [workspaceId, mastercardId],
    );
  });

  after(async () => {
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  it("Checking -> Visa: income 3,000.00, a 41.00 card purchase, the card paid from checking: 3,000.00, 2,959.00, 2,959.00", async () => {
    await post(`/accounts/${checkingId}/transactions`, { occurredAt: "2027-01-02", splits: [{ categoryId: null, amountCents: 300_000 }] });
    await post(`/accounts/${visaId}/transactions`, { occurredAt: "2027-01-05", payee: "Supermarket", splits: [{ categoryId: groceriesId, amountCents: -4_100 }] });
    await post("/transfers", { sourceAccountId: checkingId, destinationAccountId: visaId, occurredAt: "2027-01-10", amountCents: 4_100 });

    const list = await events("2027-01");
    assert.deepEqual(
      list.map((e) => [e.date, e.amountCents]),
      [
        ["2027-01-02", 300_000],
        ["2027-01-05", -4_100],
      ],
    );
    // The line on days 2, 5 and 10 (the payment's own day, where nothing moves) — the line ends at 2,959.00, not 2,918.00.
    const totals = runningTotals(list);
    assert.deepEqual([totals[0], totals[1], totals.at(-1)], [300_000, 295_900, 295_900]);
  });

  it("Checking -> Savings, card to card, a card's starting balance: no events; Checking <-> Broker: each counts once", async () => {
    await post(`/accounts/${checkingId}/transactions`, { occurredAt: "2027-02-02", splits: [{ categoryId: null, amountCents: 300_000 }] });
    await post(`/accounts/${visaId}/transactions`, { occurredAt: "2027-02-05", payee: "Supermarket", splits: [{ categoryId: groceriesId, amountCents: -4_100 }] });
    await post("/transfers", { sourceAccountId: checkingId, destinationAccountId: visaId, occurredAt: "2027-02-10", amountCents: 4_100 });
    await post("/transfers", { sourceAccountId: checkingId, destinationAccountId: savingsId, occurredAt: "2027-02-12", amountCents: 50_000 });
    await post("/transfers", { sourceAccountId: visaId, destinationAccountId: mastercardId, occurredAt: "2027-02-14", amountCents: 12_345 });
    await post("/transfers", { sourceAccountId: checkingId, destinationAccountId: brokerId, occurredAt: "2027-02-16", amountCents: 60_000, categoryId: investingId });
    await post("/transfers", { sourceAccountId: brokerId, destinationAccountId: checkingId, occurredAt: "2027-02-18", amountCents: 25_000 });

    const list = await events("2027-02");
    assert.deepEqual(
      list.map((e) => [e.date, e.amountCents]),
      [
        ["2027-02-02", 300_000],
        ["2027-02-05", -4_100],
        ["2027-02-16", -60_000],
        ["2027-02-18", 25_000],
      ],
    );
    assert.deepEqual(runningTotals(list), [300_000, 295_900, 235_900, 260_900]);

    // Property: the events add up to the change in on-budget cash less the change in card debt,
    // card starting balances left out — read straight from the ledger.
    const ledger = await superuserPool.query<{ cash: string; cards: string }>(
      `SELECT
         COALESCE(SUM(s.amount_cents) FILTER (WHERE a.type <> 'credit_card'), 0) AS cash,
         COALESCE(SUM(s.amount_cents) FILTER (WHERE a.type = 'credit_card'), 0) AS cards
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN splits s ON s.transaction_id = t.id
       WHERE t.workspace_id = $1 AND a.on_budget AND t.payee IS DISTINCT FROM 'Starting balance'
         AND t.occurred_at >= '2027-02-01' AND t.occurred_at < '2027-03-01'`,
      [workspaceId],
    );
    const cashChange = Number(ledger.rows[0]!.cash);
    const cardDebtChange = 0 - Number(ledger.rows[0]!.cards); // a card owes with a negative balance (`0 -`, not unary minus: no -0)
    assert.equal(cashChange, 300_000 - 4_100 - 50_000 + 50_000 - 60_000 + 25_000);
    assert.equal(cardDebtChange, 4_100 - 4_100 + 12_345 - 12_345);
    assert.equal(
      list.reduce((sum, e) => sum + e.amountCents, 0),
      cashChange - cardDebtChange,
    );
  });

  it("filtered to one account, every leg of that account still shows, the starting balance excepted", async () => {
    const byAccount = async (id: string) => {
      const response = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/budget-months/2027-02/events?accountId=${id}`,
        headers: auth(),
      });
      return (response.json().events as Array<{ amountCents: number; kind: string }>).filter((e) => e.kind !== "scheduled").map((e) => e.amountCents);
    };
    assert.deepEqual(await byAccount(visaId), [-4_100, 4_100, -12_345]);
    assert.deepEqual(await byAccount(mastercardId), [12_345]);
    assert.deepEqual(await byAccount(brokerId), [60_000, -25_000]);
  });
});
