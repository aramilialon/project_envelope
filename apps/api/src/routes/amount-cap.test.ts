/**
 * The cap on a single amount (#651, ADR 0002): `MAX_AMOUNT_CENTS`, 10^12 minor units. Every write
 * path accepts an amount at the cap and refuses one minor unit more with 400 `amount_too_large`
 * and the cap in `details.max`. Two transfers at the cap still give a readable budget month; rows
 * stored before the cap that add up beyond the safe range make it answer 422
 * `amount_total_overflow` naming them, and `scripts/dev/find-amounts-over-cap.sql` lists them.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";

import { MAX_AMOUNT_CENTS } from "@envelope/core";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { requireIntegrationTestEnv, setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

requireIntegrationTestEnv();

// Every figure is derived from the cap, so that the tests follow it if it ever changes.
const CAP = MAX_AMOUNT_CENTS;
/** An amount as a CSV file writes it, with a dot and two decimals. */
const csvAmount = (minorUnits: number): string => (minorUnits / 100).toFixed(2);
const PRECHECK = new URL("../../../../scripts/dev/find-amounts-over-cap.sql", import.meta.url);

interface ErrorBody {
  readonly error: string;
  readonly details: Readonly<Record<string, string | number>>;
}

describe("the cap on a single amount (#651)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  let checkingId: string;
  let brokerId: string;
  let brokerageId: string;
  let portfolioId: string;
  let instrumentId: string;
  let groceriesId: string;

  async function request<T>(method: "GET" | "POST" | "PATCH" | "PUT", path: string, payload?: unknown): Promise<{ status: number; body: T }> {
    const response = await app.fastify.inject({
      method,
      url: `/workspaces/${workspaceId}${path}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: response.statusCode, body: response.body === "" ? (undefined as T) : (response.json() as T) };
  }

  async function accepted<T = unknown>(method: "POST" | "PATCH" | "PUT", path: string, payload: unknown): Promise<T> {
    const response = await request<T>(method, path, payload);
    assert.ok(response.status >= 200 && response.status < 300, `${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  }

  /** Answers 400 `amount_too_large` with the cap; returns the details for further checks. */
  async function tooLarge(method: "POST" | "PATCH" | "PUT", path: string, payload: unknown): Promise<ErrorBody["details"]> {
    const response = await request<ErrorBody>(method, path, payload);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error, "amount_too_large", JSON.stringify(response.body));
    assert.equal(response.body.details.max, CAP);
    return response.body.details;
  }

  async function insertAccount(name: string, type: string, onBudget: boolean): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, $2, $3, 'EUR', $4) RETURNING id",
      [workspaceId, name, type, onBudget],
    );
    return rows[0]!.id;
  }

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
    checkingId = await insertAccount("Checking", "checking", true);
    brokerId = await insertAccount("Broker cash", "checking", false);
    brokerageId = await insertAccount("Brokerage", "brokerage", false);
    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Everyday', 1) RETURNING id",
      [workspaceId],
    );
    const category = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    groceriesId = category.rows[0]!.id;
    const portfolio = await superuserPool.query<{ id: string }>(
      "INSERT INTO portfolios (workspace_id, name) VALUES ($1, 'Long term') RETURNING id",
      [workspaceId],
    );
    portfolioId = portfolio.rows[0]!.id;
    const instrument = await superuserPool.query<{ id: string }>(
      `INSERT INTO instruments (ticker, exchange, name, type, currency, price_factor_e6)
       VALUES ($1, 'XMIL', 'Test instrument', 'fund', 'EUR', 1000000) RETURNING id`,
      [`T${randomBytes(6).toString("hex").toUpperCase()}`],
    );
    instrumentId = instrument.rows[0]!.id;
  });

  after(async () => {
    // The trades go with the workspace; only then can the instrument they referenced go.
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await superuserPool.query("DELETE FROM instruments WHERE id = $1", [instrumentId]);
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  it("the pre-check query uses the same cap as the API", async () => {
    const sql = await readFile(PRECHECK, "utf8");
    const literal = /WITH cap AS \(SELECT (\d+)::bigint AS max\)/.exec(sql);
    assert.ok(literal, "the query declares its cap as WITH cap AS (SELECT <n>::bigint AS max)");
    assert.equal(Number(literal[1]), MAX_AMOUNT_CENTS);
  });

  it("transactions: a split, and a transaction's own total, at the cap and one cent over", async () => {
    const path = `/accounts/${checkingId}/transactions`;
    const create = (splits: unknown) => ({ occurredAt: "2026-09-01", splits });
    await accepted("POST", path, create([{ categoryId: null, amountCents: CAP }]));
    await tooLarge("POST", path, create([{ categoryId: null, amountCents: CAP + 1 }]));
    await tooLarge("POST", path, create([{ categoryId: groceriesId, amountCents: -CAP - 1 }]));
    // Two splits each under the cap whose sum is over it: the transaction itself is too large.
    const half = CAP / 2;
    await accepted("POST", path, create([{ categoryId: groceriesId, amountCents: -half }, { categoryId: groceriesId, amountCents: -half }]));
    const details = await tooLarge(
      "POST",
      path,
      create([{ categoryId: groceriesId, amountCents: -half }, { categoryId: groceriesId, amountCents: -half - 1 }]),
    );
    assert.equal(details.label, "total");

    const edited = await accepted<{ id: string }>("POST", path, create([{ categoryId: groceriesId, amountCents: -100 }]));
    await tooLarge("PATCH", `${path}/${edited.id}`, { splits: [{ categoryId: groceriesId, amountCents: -CAP - 1 }] });
    await accepted("PATCH", `${path}/${edited.id}`, { splits: [{ categoryId: groceriesId, amountCents: -CAP }] });
  });

  it("transfers, and a transfer leg's edit", async () => {
    const transfer = (amountCents: number) => ({
      sourceAccountId: checkingId,
      destinationAccountId: brokerId,
      occurredAt: "2026-09-02",
      amountCents,
      categoryId: groceriesId,
    });
    const created = await accepted<{ source: { id: string } }>("POST", "/transfers", transfer(CAP));
    await tooLarge("POST", "/transfers", transfer(CAP + 1));
    await tooLarge("PATCH", `/accounts/${checkingId}/transactions/${created.source.id}`, {
      splits: [{ categoryId: groceriesId, amountCents: -CAP - 1 }],
    });
    // A smaller transfer whose leg is edited up to the cap: accepted.
    const small = await accepted<{ source: { id: string } }>("POST", "/transfers", transfer(100));
    await accepted("PATCH", `/accounts/${checkingId}/transactions/${small.source.id}`, {
      splits: [{ categoryId: groceriesId, amountCents: -CAP }],
    });
  });

  it("assignments", async () => {
    const entry = (amountCents: number) => ({
      entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: groceriesId, amountCents }],
    });
    await accepted("POST", "/assignments", entry(CAP));
    await tooLarge("POST", "/assignments", entry(CAP + 1));
  });

  it("a credit card's starting balance", async () => {
    const card = (startingBalanceCents: number) => ({ name: `Card ${randomUUID().slice(0, 8)}`, type: "credit_card", currency: "EUR", startingBalanceCents });
    await accepted("POST", "/accounts", card(CAP));
    assert.equal((await tooLarge("POST", "/accounts", card(CAP + 1))).label, "startingBalance");
  });

  it("scheduled transactions, created and edited", async () => {
    const scheduled = (amountCents: number) => ({
      accountId: checkingId,
      payee: "Landlord",
      nextDueDate: "2026-12-01",
      recurEvery: 1,
      recurUnit: "month",
      splits: [{ categoryId: groceriesId, amountCents }],
    });
    const created = await accepted<{ id: string }>("POST", "/scheduled-transactions", scheduled(CAP));
    await tooLarge("POST", "/scheduled-transactions", scheduled(CAP + 1));
    await tooLarge("PATCH", `/scheduled-transactions/${created.id}`, { splits: [{ categoryId: groceriesId, amountCents: CAP + 1 }] });
  });

  it("targets", async () => {
    const path = `/categories/${groceriesId}/goal`;
    await accepted("PUT", path, { kind: "monthly", amountCents: CAP });
    await tooLarge("PUT", path, { kind: "monthly", amountCents: CAP + 1 });
  });

  it("imports: a row of the file, and the closing balance", async () => {
    const path = `/accounts/${checkingId}/import`;
    const mapping = { hasHeaderRow: false, dateColumn: 0, dateFormat: "YYYY-MM-DD", descriptionColumn: 1, amountColumn: 2, decimalSeparator: "." };
    await accepted("POST", path, { format: "csv", mapping, content: `2026-09-03,Sale,${csvAmount(CAP)}\n` });
    await tooLarge("POST", path, { format: "csv", mapping, content: `2026-09-03,Sale,${csvAmount(CAP + 1)}\n` });
    const content = "2026-09-03,Coffee,-3.00\n";
    // The closing balance is only compared with the account's, never written: it is not capped.
    const staged = await accepted<{ closingBalance: { statementCents: number } }>("POST", path, {
      format: "csv",
      mapping,
      content,
      closingBalanceCents: (CAP / 10) * 12,
    });
    assert.equal(staged.closingBalance.statementCents, (CAP / 10) * 12);
  });

  it("imports: a staged row stored above the cap is rejected at confirmation and stays staged", async () => {
    const { rows } = await superuserPool.query<{ id: string }>(
      `INSERT INTO staged_transactions (workspace_id, account_id, occurred_at, payee, amount_cents)
       VALUES ($1, $2, '2026-09-03', 'Legacy', $3) RETURNING id`,
      [workspaceId, checkingId, -CAP - 1],
    );
    const stagedTransactionId = rows[0]!.id;
    const confirmed = await accepted<{ outcomes: unknown[] }>("POST", `/accounts/${checkingId}/staged-transactions/confirm`, {
      decisions: [{ stagedTransactionId, kind: "category", categoryId: groceriesId }],
    });
    assert.deepEqual(confirmed.outcomes, [{ stagedTransactionId, outcome: "rejected", code: "amount_too_large" }]);
    const still = await superuserPool.query("SELECT 1 FROM staged_transactions WHERE id = $1", [stagedTransactionId]);
    assert.equal(still.rowCount, 1);
    await superuserPool.query("DELETE FROM staged_transactions WHERE id = $1", [stagedTransactionId]);
  });

  it("reconciliation: the statement balance is not capped, the adjustment is", async () => {
    const reconcile = (statementBalanceCents: number, tickedTransactionIds: string[]) => ({
      date: "2026-09-30",
      statementBalanceCents,
      tickedTransactionIds,
      adjustment: { categoryId: null },
    });
    const cleared = async (accountId: string, amountCents: number) =>
      (
        await accepted<{ id: string }>("POST", `/accounts/${accountId}/transactions`, {
          occurredAt: "2026-09-04",
          status: "cleared",
          splits: [{ categoryId: amountCents > 0 ? null : groceriesId, amountCents }],
        })
      ).id;

    // Cleared 1.2 × the cap (two deposits at 0.6 × the cap), and the same on the statement: no adjustment.
    const richId = await insertAccount("Treasury", "savings", true);
    const deposits = [await cleared(richId, (CAP / 10) * 6), await cleared(richId, (CAP / 10) * 6)];
    const matched = await accepted<{ outcome: string; reconciliation: { statementBalanceCents: number } }>(
      "POST",
      `/accounts/${richId}/reconciliations`,
      reconcile((CAP / 10) * 12, deposits),
    );
    assert.equal(matched.outcome, "reconciled");
    assert.equal(matched.reconciliation.statementBalanceCents, (CAP / 10) * 12);
    const listed = await request<{ transactions: unknown[] }>("GET", `/accounts/${richId}/transactions`);
    assert.equal(listed.body.transactions.length, 2, "no adjustment transaction");

    // 0.9 × the cap on the statement, −0.2 × the cap cleared: the adjustment of 1.1 × the cap is refused.
    const owedId = await insertAccount("Savings", "savings", true);
    const spent = await cleared(owedId, -(CAP / 10) * 2);
    assert.equal((await tooLarge("POST", `/accounts/${owedId}/reconciliations`, reconcile((CAP / 10) * 9, [spent]))).label, "adjustment");
  });

  it("trades: gross, fees and taxes, created and edited", async () => {
    const base = { accountId: brokerageId, portfolioId, tradeDate: "2026-09-05" };
    await accepted("POST", "/trades", { ...base, type: "fee", feesCents: CAP });
    assert.equal((await tooLarge("POST", "/trades", { ...base, type: "fee", feesCents: CAP + 1 })).label, "feesCents");
    await accepted("POST", "/trades", { ...base, type: "tax", taxKind: "stamp_duty", grossCents: CAP });
    assert.equal((await tooLarge("POST", "/trades", { ...base, type: "tax", taxKind: "stamp_duty", grossCents: CAP + 1 })).label, "grossCents");
    // Ten units at a tenth of the cap each, so that quantity × price is the cap and the price stays
    // inside the range of ADR 0011 (about 9 billion per unit).
    const units = 10;
    const buy = { ...base, type: "buy", instrumentId, quantityE8: units * 100_000_000, priceE6: (CAP / 100 / units) * 1_000_000 };
    await accepted("POST", "/trades", { ...buy, grossCents: CAP });
    assert.equal((await tooLarge("POST", "/trades", { ...buy, grossCents: CAP + 1 })).label, "grossCents");
    // Each figure at the cap, but the cash leg one cent over it.
    assert.equal((await tooLarge("POST", "/trades", { ...buy, grossCents: CAP, feesCents: 1 })).label, "cash");

    const fee = await accepted<{ trades: { id: string }[] }>("POST", "/trades", { ...base, type: "fee", feesCents: 100 });
    const tradePath = `/trades/${fee.trades[0]!.id}`;
    assert.equal((await tooLarge("PATCH", tradePath, { feesCents: CAP + 1 })).label, "feesCents");
    await accepted("PATCH", tradePath, { feesCents: CAP });
  });

  it("trades stored before the cap: a position cost beyond the safe range answers 422 naming the trade", async () => {
    const oldBrokerageId = await insertAccount("Old brokerage", "brokerage", false);
    const ids: string[] = [];
    for (const day of ["2026-09-06", "2026-09-07"]) {
      const { rows } = await superuserPool.query<{ id: string }>(
        `INSERT INTO trades (workspace_id, account_id, portfolio_id, instrument_id, type, trade_date, quantity_e8, price_e6, gross_cents)
         VALUES ($1, $2, $3, $4, 'buy', $5, 100000000, 1000000, $6) RETURNING id`,
        [workspaceId, oldBrokerageId, portfolioId, instrumentId, day, 2 ** 52],
      );
      ids.push(rows[0]!.id);
    }
    const positions = await request<ErrorBody>("GET", `/accounts/${oldBrokerageId}/positions`);
    assert.equal(positions.status, 422, JSON.stringify(positions.body));
    assert.equal(positions.body.error, "amount_total_overflow");
    assert.equal(positions.body.details.tradeId, ids[1]);
    await superuserPool.query("DELETE FROM trades WHERE id = ANY($1)", [ids]);
  });

  it("two transfers in at the cap still give a readable budget month", async () => {
    for (const day of ["2026-09-10", "2026-09-11"]) {
      await accepted("POST", "/transfers", { sourceAccountId: brokerId, destinationAccountId: checkingId, occurredAt: day, amountCents: CAP });
    }
    const month = await request<{ unassigned: number }>("GET", "/budget-months/2026-09");
    assert.equal(month.status, 200, JSON.stringify(month.body));
    assert.ok(month.body.unassigned >= 2 * CAP, String(month.body.unassigned));
  });

  it("rows stored before the cap: the pre-check lists them, and a month they overflow answers 422 naming them", async () => {
    const legacy: string[] = [];
    for (const amount of [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER - 2]) {
      const { rows } = await superuserPool.query<{ id: string }>(
        "INSERT INTO transactions (workspace_id, account_id, occurred_at, status) VALUES ($1, $2, '2026-09-20', 'pending') RETURNING id",
        [workspaceId, checkingId],
      );
      const id = rows[0]!.id;
      await superuserPool.query("INSERT INTO splits (workspace_id, transaction_id, category_id, amount_cents) VALUES ($1, $2, NULL, $3)", [
        workspaceId,
        id,
        amount,
      ]);
      legacy.push(id);
    }

    const listed = await superuserPool.query<{ kind: string; workspace_id: string; id: string }>(await readFile(PRECHECK, "utf8"));
    const ours = listed.rows.filter((row) => row.workspace_id === workspaceId);
    assert.deepEqual(ours.map((row) => row.id).sort(), [...legacy].sort());
    assert.ok(ours.every((row) => row.kind === "transaction"));

    const month = await request<ErrorBody>("GET", "/budget-months/2026-09");
    assert.equal(month.status, 422, JSON.stringify(month.body));
    assert.equal(month.body.error, "amount_total_overflow");
    assert.deepEqual(String(month.body.details.transactionIds).split(",").sort(), [...legacy].sort());

    await superuserPool.query("DELETE FROM transactions WHERE id = ANY($1)", [legacy]);
    assert.equal((await request("GET", "/budget-months/2026-09")).status, 200);
  });
});
