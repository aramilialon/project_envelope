import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { MAX_FREE_TEXT_LENGTH } from "@envelope/core";

import { decodeJwt } from "jose";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

/** Units as quantityE8: units(1.5) is 150000000. */
const units = (value: number): number => Math.round(value * 1e8);
/** A price as priceE6. */
const price = (value: number): number => Math.round(value * 1e6);

interface TradeBody {
  readonly id: string;
  readonly accountId: string;
  readonly portfolioId: string;
  readonly instrumentId: string | null;
  readonly type: string;
  readonly tradeDate: string;
  readonly quantityE8: number;
  readonly grossCents: number;
  readonly feesCents: number;
  readonly costBasisCents: number | null;
  readonly splitFrom: number | null;
  readonly splitTo: number | null;
  readonly transferTradeId: string | null;
  readonly memo: string | null;
  readonly createdAt: string;
  readonly cashCents: number;
  readonly cashTransactionId: string | null;
  readonly locked: boolean;
}

describe("trades routes (#77)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  let userId: string;
  const otherWorkspaceIds: string[] = [];
  const instrumentIds: string[] = [];

  async function auth(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${token}` };
  }

  async function post(payload: Record<string, unknown>, ws = workspaceId) {
    return app.fastify.inject({ method: "POST", url: `/workspaces/${ws}/trades`, headers: await auth(), payload });
  }

  async function list(query = "", ws = workspaceId) {
    return app.fastify.inject({ method: "GET", url: `/workspaces/${ws}/trades${query}`, headers: await auth() });
  }

  async function created(payload: Record<string, unknown>, ws = workspaceId): Promise<TradeBody[]> {
    const response = await post(payload, ws);
    assert.equal(response.statusCode, 201, response.body);
    return response.json().trades;
  }

  async function rejected(payload: Record<string, unknown>, code: string, ws = workspaceId): Promise<Record<string, unknown>> {
    const before = await countTrades(ws);
    const response = await post(payload, ws);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, code, response.body);
    // Nothing is written when a request is refused.
    assert.equal(await countTrades(ws), before);
    return response.json().details;
  }

  async function countTrades(ws = workspaceId): Promise<number> {
    const { rows } = await superuserPool.query<{ count: string }>("SELECT count(*) FROM trades WHERE workspace_id = $1", [ws]);
    return Number(rows[0]!.count);
  }

  async function instrument(type = "fund", currency = "EUR", priceFactorE6 = 1_000_000): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      `INSERT INTO instruments (ticker, exchange, name, type, currency, price_factor_e6)
       VALUES ($1, 'XMIL', 'Test instrument', $2, $3, $4) RETURNING id`,
      [`T${randomBytes(6).toString("hex").toUpperCase()}`, type, currency, priceFactorE6],
    );
    instrumentIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function account(type = "brokerage", currency = "EUR", ws = workspaceId, domesticWithholdingAgent: boolean | null = null) {
    const { rows } = await superuserPool.query<{ id: string }>(
      `INSERT INTO accounts (workspace_id, name, type, currency, on_budget, domestic_withholding_agent)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [ws, `Account ${randomUUID().slice(0, 8)}`, type, currency, type !== "brokerage", domesticWithholdingAgent],
    );
    return rows[0]!.id;
  }

  async function portfolio(ws = workspaceId): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO portfolios (workspace_id, name) VALUES ($1, $2) RETURNING id",
      [ws, `Portfolio ${randomUUID()}`],
    );
    return rows[0]!.id;
  }

  async function addWorkspace(role: "owner" | "editor" | "read_only", taxCountry: string | null = null): Promise<string> {
    const id = randomUUID();
    otherWorkspaceIds.push(id);
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone, tax_country) VALUES ($1, 'Other', 'EUR', 'Europe/Rome', $2)",
      [id, taxCountry],
    );
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [userId, id, role]);
    return id;
  }

  async function setRole(role: "owner" | "editor" | "read_only"): Promise<void> {
    await superuserPool.query("UPDATE memberships SET role = $1 WHERE user_id = $2 AND workspace_id = $3", [role, userId, workspaceId]);
  }

  async function legOf(trade: TradeBody) {
    const { rows } = await superuserPool.query<{
      account_id: string;
      status: string;
      trade_id: string;
      local_date: string;
      amount_cents: string;
      category_id: string | null;
      split_count: string;
    }>(
      `SELECT t.account_id, t.status, t.trade_id,
              to_char(t.occurred_at AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD HH24:MI') AS local_date,
              (SELECT sum(amount_cents) FROM splits WHERE transaction_id = t.id) AS amount_cents,
              (SELECT min(category_id::text) FROM splits WHERE transaction_id = t.id) AS category_id,
              (SELECT count(*) FROM splits WHERE transaction_id = t.id) AS split_count
       FROM transactions t WHERE t.id = $1`,
      [trade.cashTransactionId],
    );
    return rows[0];
  }

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [decodeJwt(token).sub]);
    userId = rows[0]!.id;
  });

  after(async () => {
    // The trades go with their workspaces; only then can the instruments they referenced go.
    await superuserPool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[...otherWorkspaceIds, workspaceId]]);
    await superuserPool.query("DELETE FROM instruments WHERE id = ANY($1)", [instrumentIds]);
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/trades` });
    assert.equal(response.statusCode, 401);
  });

  it("records a buy with its cash leg, defaulting the gross to quantity × price, and lists it", async () => {
    const etf = await instrument();
    const broker = await account();
    const growth = await portfolio();
    const [buy] = await created({
      type: "buy",
      accountId: broker,
      portfolioId: growth,
      instrumentId: etf,
      tradeDate: "2026-03-02",
      occurredAt: "2026-03-02T10:15:00+01:00",
      quantityE8: units(10),
      priceE6: price(87.123456),
      feesCents: 500,
      transactionTaxCents: 120,
      memo: "Monthly plan",
    });
    assert.ok(buy);
    assert.equal(buy.grossCents, 87_123); // 871.23456, half away from zero
    assert.equal(buy.cashCents, -(87_123 + 500 + 120));
    assert.equal(buy.memo, "Monthly plan");
    assert.equal(buy.locked, false);

    const leg = await legOf(buy);
    assert.deepEqual(leg, {
      account_id: broker,
      status: "pending",
      trade_id: buy.id,
      local_date: "2026-03-02 00:00",
      amount_cents: String(-(87_123 + 500 + 120)),
      category_id: null,
      split_count: "1",
    });

    const listed = await list(`?accountId=${broker}`);
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().trades, [buy]);

    const { rows: audit } = await superuserPool.query<{ action: string; after: { trades: { id: string }[] } }>(
      "SELECT action, after FROM audit_log WHERE workspace_id = $1 AND action = 'trade.create'",
      [workspaceId],
    );
    assert.ok(audit.some((entry) => entry.after.trades[0]?.id === buy.id));
  });

  it("keeps a gross the broker charged instead of the computed one", async () => {
    const etf = await instrument();
    const [buy] = await created({
      type: "buy",
      accountId: await account(),
      portfolioId: await portfolio(),
      instrumentId: etf,
      tradeDate: "2026-03-02",
      quantityE8: units(10),
      priceE6: price(87.123456),
      grossCents: 87_124,
    });
    assert.equal(buy!.grossCents, 87_124);
    assert.equal(buy!.cashCents, -87_124);
  });

  it("accepts a client-generated id, and refuses it a second time", async () => {
    const etf = await instrument();
    const broker = await account();
    const growth = await portfolio();
    const id = randomUUID();
    const payload = { id, type: "buy", accountId: broker, portfolioId: growth, instrumentId: etf, tradeDate: "2026-01-05", quantityE8: units(1), priceE6: price(10) };
    const [buy] = await created(payload);
    assert.equal(buy!.id, id);
    const again = await post(payload);
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().code, "id_taken");
  });

  it("refuses a sale that would make a portfolio's holding negative, now or at a later sale", async () => {
    const etf = await instrument();
    const broker = await account();
    const growth = await portfolio();
    const other = await portfolio();
    const base = { accountId: broker, instrumentId: etf, priceE6: price(100) };
    await created({ ...base, type: "buy", portfolioId: growth, tradeDate: "2026-01-10", quantityE8: units(10) });
    await created({ ...base, type: "buy", portfolioId: other, tradeDate: "2026-01-10", quantityE8: units(30) });

    // The account holds 40, but this portfolio only 10.
    const details = await rejected({ ...base, type: "sell", portfolioId: growth, tradeDate: "2026-02-01", quantityE8: units(11) }, "insufficient_quantity");
    assert.equal(details.portfolioId, growth);
    assert.equal(details.date, "2026-02-01");
    assert.equal(details.available, units(10));
    assert.equal(details.requested, units(11));

    await created({ ...base, type: "sell", portfolioId: growth, tradeDate: "2026-03-01", quantityE8: units(8) });
    // Backdated before the sale of 8: that later sale would then sell more than the portfolio held.
    const later = await rejected({ ...base, type: "sell", portfolioId: growth, tradeDate: "2026-02-01", quantityE8: units(5) }, "insufficient_quantity");
    assert.equal(later.date, "2026-03-01");
  });

  it("serializes concurrent trades of one instrument, so two sales cannot together oversell", async () => {
    const etf = await instrument();
    const broker = await account();
    const growth = await portfolio();
    const base = { accountId: broker, portfolioId: growth, instrumentId: etf, priceE6: price(10) };
    await created({ ...base, type: "buy", tradeDate: "2026-01-10", quantityE8: units(10) });

    const sale = { ...base, type: "sell", tradeDate: "2026-02-10", quantityE8: units(6) };
    const responses = await Promise.all([post(sale), post(sale)]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 400]);
    const refused = responses.find((response) => response.statusCode === 400)!;
    assert.equal(refused.json().error, "insufficient_quantity");

    const { rows } = await superuserPool.query<{ held: string }>(
      "SELECT sum(CASE WHEN type = 'sell' THEN -quantity_e8 ELSE quantity_e8 END) AS held FROM trades WHERE account_id = $1",
      [broker],
    );
    assert.equal(Number(rows[0]!.held), units(4));
  });

  it("orders a trade with no time as midnight UTC of its date, before a timed one", async () => {
    const etf = await instrument();
    const base = { accountId: await account(), portfolioId: await portfolio(), instrumentId: etf, priceE6: price(10), quantityE8: units(1) };
    await created({ ...base, type: "buy", tradeDate: "2026-01-10", occurredAt: "2026-01-10T10:00:00+01:00" });
    // Untimed, the sale replays before the 10:00 buy of the same day: nothing is held yet.
    await rejected({ ...base, type: "sell", tradeDate: "2026-01-10" }, "insufficient_quantity");
  });

  it("refuses a time that is not on the trade date in the workspace's time zone", async () => {
    const base = { type: "fee", accountId: await account(), portfolioId: await portfolio(), feesCents: 100, tradeDate: "2026-01-10" };
    // 23:30 UTC on the 9th is 00:30 on the 10th in Rome: on the date.
    await created({ ...base, occurredAt: "2026-01-09T23:30:00Z" });
    const details = await rejected({ ...base, occurredAt: "2026-01-10T23:30:00Z" }, "invalid_trade");
    assert.equal(details.field, "occurredAt");
  });

  it("refuses a fee or a tax of zero", async () => {
    const base = { accountId: await account(), portfolioId: await portfolio(), tradeDate: "2026-01-10" };
    assert.equal((await rejected({ ...base, type: "fee" }, "invalid_trade")).field, "feesCents");
    assert.equal((await rejected({ ...base, type: "tax", taxKind: "stamp_duty", grossCents: 0 }, "invalid_trade")).field, "grossCents");
    assert.equal((await rejected({ ...base, type: "tax", taxKind: "gain_tax_adjustment", grossCents: 0 }, "invalid_trade")).field, "grossCents");
  });

  it("records a bond sale with accrued interest and its domestic withholding, and refuses a withholding above the interest", async () => {
    const bond = await instrument("bond", "EUR", 10_000);
    const base = { accountId: await account(), portfolioId: await portfolio(), instrumentId: bond };
    await created({ ...base, type: "buy", tradeDate: "2026-01-10", quantityE8: units(10_000), priceE6: price(98) });
    const [sale] = await created({
      ...base,
      type: "sell",
      tradeDate: "2026-06-10",
      quantityE8: units(10_000),
      priceE6: price(100),
      accruedInterestCents: 4_000,
      withholdingDomesticCents: 500,
      feesCents: 500,
    });
    assert.equal(sale!.grossCents, 1_000_000);
    assert.equal(sale!.cashCents, 1_000_000 + 4_000 - 500 - 500);
    assert.equal((await legOf(sale!))?.amount_cents, String(1_003_000));

    const details = await rejected(
      { ...base, type: "buy", tradeDate: "2026-07-01", quantityE8: units(1_000), priceE6: price(99), accruedInterestCents: 100, withholdingDomesticCents: 101 },
      "withholding_exceeds_gross",
    );
    assert.deepEqual(details, { field: "withholdingDomesticCents", withheld: 101, gross: 100 });
  });

  it("answers 409 for a leg id another workspace already uses, leaving nothing behind", async () => {
    const etf = await instrument();
    const elsewhere = await addWorkspace("owner");
    const foreignAccount = await account("brokerage", "EUR", elsewhere);
    const foreignPortfolio = await portfolio(elsewhere);
    const [foreign] = await created(
      { type: "buy", accountId: foreignAccount, portfolioId: foreignPortfolio, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(1), priceE6: price(1) },
      elsewhere,
    );

    const broker = await account();
    const growth = await portfolio();
    await created({ type: "buy", accountId: broker, portfolioId: growth, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(5), priceE6: price(1) });
    const before = await countTrades();
    const { rows: legsBefore } = await superuserPool.query("SELECT id FROM transactions WHERE workspace_id = $1", [workspaceId]);
    const response = await post({
      type: "transfer",
      instrumentId: etf,
      tradeDate: "2026-02-01",
      quantityE8: units(1),
      from: { accountId: broker, portfolioId: growth, feesCents: 300 },
      to: { id: foreign!.id, accountId: await account(), portfolioId: growth },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "id_taken");
    assert.equal(await countTrades(), before);
    const { rows: legsAfter } = await superuserPool.query("SELECT id FROM transactions WHERE workspace_id = $1", [workspaceId]);
    assert.equal(legsAfter.length, legsBefore.length);
  });

  it("refuses a sale in another account even though the workspace holds the instrument", async () => {
    const etf = await instrument();
    const growth = await portfolio();
    const base = { instrumentId: etf, portfolioId: growth, priceE6: price(50) };
    await created({ ...base, type: "buy", accountId: await account(), tradeDate: "2026-01-10", quantityE8: units(5) });
    await rejected({ ...base, type: "sell", accountId: await account(), tradeDate: "2026-02-10", quantityE8: units(1) }, "insufficient_quantity");
  });

  it("writes each type's cash leg from the cash-leg table", async () => {
    const stock = await instrument("stock");
    const broker = await account();
    const growth = await portfolio();
    const base = { accountId: broker, portfolioId: growth };
    await created({ ...base, type: "buy", instrumentId: stock, tradeDate: "2026-01-10", quantityE8: units(100), priceE6: price(50), feesCents: 500 });

    const [sell] = await created({
      ...base,
      type: "sell",
      instrumentId: stock,
      tradeDate: "2026-02-10",
      quantityE8: units(60),
      priceE6: price(70),
      feesCents: 500,
      transactionTaxCents: 100,
      gainTaxCents: 24_726,
    });
    assert.equal(sell!.cashCents, 420_000 - 500 - 100 - 24_726);

    const [dividend] = await created({
      ...base,
      type: "dividend",
      instrumentId: stock,
      tradeDate: "2026-03-10",
      grossCents: 2_000,
      withholdingForeignCents: 300,
      withholdingDomesticCents: 442,
      feesCents: 200,
    });
    assert.equal(dividend!.cashCents, 1_058);

    const [custody] = await created({ ...base, type: "fee", instrumentId: null, tradeDate: "2026-03-31", feesCents: 1_200 });
    assert.equal(custody!.instrumentId, null);
    assert.equal(custody!.cashCents, -1_200);

    const [stampDuty] = await created({ ...base, type: "tax", taxKind: "stamp_duty", tradeDate: "2026-03-31", grossCents: 3_400 });
    assert.equal(stampDuty!.cashCents, -3_400);

    const [refund] = await created({ ...base, type: "tax", taxKind: "gain_tax_adjustment", instrumentId: stock, tradeDate: "2026-04-01", grossCents: 10_000 });
    assert.equal(refund!.cashCents, 10_000);
    const [extra] = await created({ ...base, type: "tax", taxKind: "gain_tax_adjustment", tradeDate: "2026-04-02", grossCents: -4_000 });
    assert.equal(extra!.cashCents, -4_000);

    for (const trade of [sell, dividend, custody, stampDuty, refund, extra]) {
      const leg = await legOf(trade!);
      assert.equal(leg?.amount_cents, String(trade!.cashCents));
      assert.equal(leg?.account_id, broker);
    }
  });

  it("records a bond buy with accrued interest and a domestic withholding credited back", async () => {
    const bond = await instrument("government_bond", "EUR", 10_000);
    const [buy] = await created({
      type: "buy",
      accountId: await account(),
      portfolioId: await portfolio(),
      instrumentId: bond,
      tradeDate: "2026-05-04",
      quantityE8: units(10_000),
      priceE6: price(98.765432),
      accruedInterestCents: 3_000,
      withholdingDomesticCents: 375,
    });
    assert.equal(buy!.grossCents, 987_654);
    assert.equal(buy!.cashCents, -(987_654 + 3_000 - 375));
  });

  it("refuses a trade off a brokerage account, in another currency, or naming what does not exist", async () => {
    const etf = await instrument();
    const broker = await account();
    const growth = await portfolio();
    const base = { type: "buy", tradeDate: "2026-01-10", quantityE8: units(1), priceE6: price(10) };

    const checking = await account("checking");
    const notBrokerage = await rejected({ ...base, accountId: checking, portfolioId: growth, instrumentId: etf }, "account_not_brokerage");
    assert.equal(notBrokerage.accountId, checking);

    const usd = await instrument("stock", "USD");
    const mismatch = await rejected({ ...base, accountId: broker, portfolioId: growth, instrumentId: usd }, "currency_mismatch");
    assert.deepEqual(mismatch, { accountId: broker, accountCurrency: "EUR", instrumentCurrency: "USD" });

    await rejected({ ...base, accountId: broker, portfolioId: randomUUID(), instrumentId: etf }, "unknown_portfolio");
    await rejected({ ...base, accountId: broker, portfolioId: growth, instrumentId: randomUUID() }, "unknown_instrument");
    await rejected({ ...base, accountId: randomUUID(), portfolioId: growth, instrumentId: etf }, "unknown_account");
  });

  it("does not let a trade reference another workspace's account or portfolio", async () => {
    const etf = await instrument();
    const elsewhere = await addWorkspace("owner");
    const foreignAccount = await account("brokerage", "EUR", elsewhere);
    const foreignPortfolio = await portfolio(elsewhere);
    const base = { type: "buy", tradeDate: "2026-01-10", quantityE8: units(1), priceE6: price(10), instrumentId: etf };
    await rejected({ ...base, accountId: foreignAccount, portfolioId: await portfolio() }, "unknown_account");
    await rejected({ ...base, accountId: await account(), portfolioId: foreignPortfolio }, "unknown_portfolio");
  });

  it("refuses negative amounts, a misplaced tax kind, accrued interest on a non-bond and withholdings above the gross", async () => {
    const stock = await instrument("stock");
    const broker = await account();
    const growth = await portfolio();
    const base = { accountId: broker, portfolioId: growth, instrumentId: stock, tradeDate: "2026-01-10" };
    await created({ ...base, type: "buy", quantityE8: units(10), priceE6: price(10) });

    const negative = await rejected({ ...base, type: "buy", quantityE8: units(1), priceE6: price(10), feesCents: -1 }, "negative_amount_not_allowed");
    assert.equal(negative.field, "feesCents");
    await rejected({ ...base, type: "tax", taxKind: "other", grossCents: -10 }, "negative_amount_not_allowed");

    const taxKind = await rejected({ ...base, type: "dividend", grossCents: 100, taxKind: "stamp_duty" }, "tax_kind_not_allowed_for_trade_type");
    assert.deepEqual(taxKind, { type: "dividend", taxKind: "stamp_duty" });

    const interest = await rejected(
      { ...base, type: "buy", quantityE8: units(1), priceE6: price(10), accruedInterestCents: 50 },
      "accrued_interest_not_allowed",
    );
    assert.deepEqual(interest, { instrumentType: "stock" });

    const withholding = await rejected(
      { ...base, type: "dividend", grossCents: 1_000, withholdingForeignCents: 700, withholdingDomesticCents: 301 },
      "withholding_exceeds_gross",
    );
    assert.equal(withholding.withheld, 1_001);
  });

  it("refuses a body that breaks the shape of its type, with the core's codes", async () => {
    const etf = await instrument();
    const base = { accountId: await account(), portfolioId: await portfolio(), instrumentId: etf, tradeDate: "2026-01-10" };
    const field = await rejected({ ...base, type: "dividend", grossCents: 100, quantityE8: units(1) }, "invalid_trade");
    assert.equal(field.field, "quantity");
    await rejected({ ...base, type: "buy", quantityE8: 0, priceE6: price(1) }, "invalid_trade");
    await rejected({ ...base, type: "buy", quantityE8: 0.5, priceE6: price(1) }, "invalid_quantity");
    await rejected({ ...base, type: "buy", quantityE8: units(1), priceE6: -1 }, "invalid_price");
    await rejected({ ...base, tradeDate: "2026-02-30", type: "buy", quantityE8: units(1), priceE6: price(1) }, "invalid_date");
    await rejected({ ...base, type: "buy", occurredAt: "yesterday", quantityE8: units(1), priceE6: price(1) }, "invalid_trade");

    for (const payload of [
      { ...base, type: "swap" },
      { ...base, type: "buy", tradeDate: undefined },
      { ...base, type: "buy", accountId: "not-a-uuid" },
      { ...base, type: "buy", quantityE8: "10" },
      { ...base, type: "buy", taxKind: "vat" },
      { ...base, type: "transfer", quantityE8: units(1) },
      { ...base, type: "split", splitFrom: 1 },
    ]) {
      const response = await post(payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.match(response.json().error, /^invalid trade: /);
    }
  });

  it("caps the memo at 500 characters", async () => {
    const response = await post({
      type: "fee",
      accountId: await account(),
      portfolioId: await portfolio(),
      tradeDate: "2026-01-10",
      feesCents: 100,
      memo: "x".repeat(MAX_FREE_TEXT_LENGTH + 1),
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "text_too_long", details: { field: "memo", max: MAX_FREE_TEXT_LENGTH } });
  });

  it("refuses a create body with a field it does not know, at the top level or in a transfer leg", async () => {
    const etf = await instrument();
    const broker = await account();
    const growth = await portfolio();
    await created({ type: "buy", accountId: broker, portfolioId: growth, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(5), priceE6: price(10) });
    const before = await countTrades();
    for (const payload of [
      { type: "fee", accountId: broker, portfolioId: growth, tradeDate: "2026-01-10", feesCents: 100, fee: 100 },
      { type: "buy", accountId: broker, portfolioId: growth, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(1), priceE6: price(10), quantity: 1 },
      { type: "transfer", instrumentId: etf, tradeDate: "2026-02-01", quantityE8: units(1), from: { accountId: broker, portfolioId: growth, fees: 1 } },
    ]) {
      const response = await post(payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.match(response.json().error, /^invalid trade: .* is not a field of this request$/);
    }
    assert.equal(await countTrades(), before);
  });

  describe("transfers", () => {
    it("moves units between two portfolios of one account: two linked legs, no cash", async () => {
      const etf = await instrument();
      const broker = await account();
      const [from, to] = [await portfolio(), await portfolio()];
      await created({ type: "buy", accountId: broker, portfolioId: from, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(10), priceE6: price(100) });

      const legs = await created({
        type: "transfer",
        instrumentId: etf,
        tradeDate: "2026-02-01",
        quantityE8: units(4),
        from: { accountId: broker, portfolioId: from },
        to: { accountId: broker, portfolioId: to },
      });
      assert.equal(legs.length, 2);
      const outgoing = legs.find((leg) => leg.quantityE8 < 0)!;
      const incoming = legs.find((leg) => leg.quantityE8 > 0)!;
      assert.equal(outgoing.quantityE8, -units(4));
      assert.equal(outgoing.portfolioId, from);
      assert.equal(incoming.portfolioId, to);
      assert.equal(outgoing.transferTradeId, incoming.id);
      assert.equal(incoming.transferTradeId, outgoing.id);
      assert.equal(incoming.costBasisCents, null);
      assert.equal(outgoing.cashTransactionId, null);
      assert.equal(incoming.cashTransactionId, null);

      await rejected(
        { type: "transfer", instrumentId: etf, tradeDate: "2026-02-02", quantityE8: units(7), from: { accountId: broker, portfolioId: from }, to: { accountId: broker, portfolioId: to } },
        "insufficient_quantity",
      );
      await rejected(
        { type: "transfer", instrumentId: etf, tradeDate: "2026-02-02", quantityE8: units(1), from: { accountId: broker, portfolioId: from }, to: { accountId: broker, portfolioId: from } },
        "invalid_trade",
      );
    });

    it("moves units between two accounts, the outgoing leg paying its fees, with no cost on the incoming leg", async () => {
      const etf = await instrument();
      const [source, target] = [await account(), await account()];
      const growth = await portfolio();
      await created({ type: "buy", accountId: source, portfolioId: growth, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(10), priceE6: price(100) });

      const fromId = randomUUID();
      const toId = randomUUID();
      const legs = await created({
        type: "transfer",
        instrumentId: etf,
        tradeDate: "2026-02-01",
        quantityE8: units(5),
        from: { id: fromId, accountId: source, portfolioId: growth, feesCents: 2_500 },
        to: { id: toId, accountId: target, portfolioId: growth },
      });
      const outgoing = legs.find((leg) => leg.id === fromId)!;
      const incoming = legs.find((leg) => leg.id === toId)!;
      assert.equal(outgoing.cashCents, -2_500);
      assert.equal((await legOf(outgoing))?.account_id, source);
      assert.equal(incoming.cashTransactionId, null);
      assert.equal(incoming.costBasisCents, null);

      // The incoming cost is derived from the outgoing leg: one cannot be given as well.
      const withCost = await rejected(
        {
          type: "transfer",
          instrumentId: etf,
          tradeDate: "2026-02-02",
          quantityE8: units(1),
          from: { accountId: source, portfolioId: growth },
          to: { accountId: target, portfolioId: growth, costBasisCents: 10_000 },
        },
        "invalid_trade",
      );
      assert.equal(withCost.field, "costBasisCents");
      // The units now in the target can be sold from there.
      await created({ type: "sell", accountId: target, portfolioId: growth, instrumentId: etf, tradeDate: "2026-03-01", quantityE8: units(5), priceE6: price(110) });
    });

    it("records a transfer in from outside the app only with its cost, and a transfer out of it", async () => {
      const etf = await instrument();
      const broker = await account();
      const growth = await portfolio();
      const base = { type: "transfer", instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(10) };
      const missing = await rejected({ ...base, to: { accountId: broker, portfolioId: growth } }, "invalid_trade");
      assert.equal(missing.field, "costBasisCents");

      const [incoming] = await created({ ...base, to: { accountId: broker, portfolioId: growth, costBasisCents: 100_000 } });
      assert.equal(incoming!.costBasisCents, 100_000);
      assert.equal(incoming!.transferTradeId, null);

      const [outgoing] = await created({ ...base, tradeDate: "2026-02-10", quantityE8: units(4), from: { accountId: broker, portfolioId: growth, feesCents: 900 } });
      assert.equal(outgoing!.quantityE8, -units(4));
      assert.equal(outgoing!.cashCents, -900);
      await rejected({ ...base, tradeDate: "2026-02-11", quantityE8: units(7), from: { accountId: broker, portfolioId: growth } }, "insufficient_quantity");
    });
  });

  describe("splits", () => {
    it("is entered once and creates one row for every portfolio holding the instrument, in every account", async () => {
      const etf = await instrument();
      const [first, second] = [await account(), await account()];
      const [growth, income, empty] = [await portfolio(), await portfolio(), await portfolio()];
      const buy = { type: "buy", instrumentId: etf, priceE6: price(100) };
      await created({ ...buy, accountId: first, portfolioId: growth, tradeDate: "2026-01-10", quantityE8: units(10) });
      await created({ ...buy, accountId: first, portfolioId: income, tradeDate: "2026-01-10", quantityE8: units(30) });
      await created({ ...buy, accountId: second, portfolioId: growth, tradeDate: "2026-01-10", quantityE8: units(5) });
      // Sold out before the split: needs no row.
      await created({ ...buy, accountId: second, portfolioId: empty, tradeDate: "2026-01-10", quantityE8: units(2) });
      await created({ ...buy, type: "sell", accountId: second, portfolioId: empty, tradeDate: "2026-01-20", quantityE8: units(2) });
      // On the split's own date: comes after the split, so it needs no row either.
      const other = await portfolio();
      await created({ ...buy, accountId: first, portfolioId: other, tradeDate: "2026-02-01", quantityE8: units(1) });

      const rows = await created({ type: "split", instrumentId: etf, tradeDate: "2026-02-01", splitFrom: 1, splitTo: 4 });
      assert.deepEqual(
        rows.map((row) => [row.accountId, row.portfolioId, row.splitFrom, row.splitTo, row.cashTransactionId]).sort(),
        [
          [first, growth, 1, 4, null],
          [first, income, 1, 4, null],
          [second, growth, 1, 4, null],
        ].sort(),
      );
      // 10 units are 40 after the split.
      await created({ ...buy, type: "sell", accountId: first, portfolioId: growth, tradeDate: "2026-02-02", quantityE8: units(40) });

      // A buy backdated before the split, in a portfolio that has no split row, is refused.
      const missing = await rejected({ ...buy, accountId: first, portfolioId: empty, tradeDate: "2026-01-15", quantityE8: units(1) }, "split_missing_for_portfolio");
      assert.equal(missing.portfolioId, empty);
      assert.equal(missing.date, "2026-02-01");

      // A second split on the same date would duplicate the rows.
      await rejected({ type: "split", instrumentId: etf, tradeDate: "2026-02-01", splitFrom: 1, splitTo: 4 }, "split_duplicate");
    });

    it("refuses a split no portfolio holds", async () => {
      const details = await rejected({ type: "split", instrumentId: await instrument(), tradeDate: "2026-02-01", splitFrom: 1, splitTo: 2 }, "split_without_holdings");
      assert.equal(details.date, "2026-02-01");
    });
  });

  it("lists in the replay order and filters by portfolio, account and instrument", async () => {
    const [etf, stock] = [await instrument(), await instrument("stock")];
    const [first, second] = [await account(), await account()];
    const [growth, income] = [await portfolio(), await portfolio()];
    const buy = { type: "buy", priceE6: price(10), quantityE8: units(10) };
    const [late] = await created({ ...buy, accountId: first, portfolioId: growth, instrumentId: etf, tradeDate: "2026-05-01" });
    const [early] = await created({ ...buy, accountId: first, portfolioId: income, instrumentId: etf, tradeDate: "2026-04-01" });
    const [otherAccount] = await created({ ...buy, accountId: second, portfolioId: growth, instrumentId: stock, tradeDate: "2026-04-15" });
    const [split] = await created({ type: "split", instrumentId: etf, tradeDate: "2026-05-01", splitFrom: 1, splitTo: 2 }).then((rows) =>
      rows.filter((row) => row.portfolioId === income),
    );

    const ids = async (query: string) => ((await list(query)).json().trades as TradeBody[]).map((trade) => trade.id);
    const firstAccount = await ids(`?accountId=${first}`);
    assert.equal(firstAccount[0], early!.id);
    // The split comes first on its date, before the buy of the same date.
    assert.ok(firstAccount.indexOf(split!.id) < firstAccount.indexOf(late!.id));
    assert.deepEqual(await ids(`?accountId=${second}`), [otherAccount!.id]);
    assert.deepEqual(await ids(`?instrumentId=${stock}`), [otherAccount!.id]);
    assert.deepEqual((await ids(`?portfolioId=${income}`)).sort(), [early!.id, split!.id].sort());

    const bad = await list("?portfolioId=nope");
    assert.equal(bad.statusCode, 400);
  });

  it("lets a read_only member list but not record, and an editor record", async () => {
    const etf = await instrument();
    const payload = { type: "buy", accountId: await account(), portfolioId: await portfolio(), instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(1), priceE6: price(1) };
    try {
      await setRole("read_only");
      assert.equal((await list()).statusCode, 200);
      const refused = await post(payload);
      assert.equal(refused.statusCode, 403);
      await setRole("editor");
      assert.equal((await post(payload)).statusCode, 201);
    } finally {
      await setRole("owner");
    }
  });

  it("refuses to delete a portfolio that has trades", async () => {
    const growth = await portfolio();
    await created({ type: "fee", accountId: await account(), portfolioId: growth, tradeDate: "2026-01-10", feesCents: 100 });
    const response = await app.fastify.inject({ method: "DELETE", url: `/workspaces/${workspaceId}/portfolios/${growth}`, headers: await auth() });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "portfolio_has_trades");
    const unused = await portfolio();
    const deleted = await app.fastify.inject({ method: "DELETE", url: `/workspaces/${workspaceId}/portfolios/${unused}`, headers: await auth() });
    assert.equal(deleted.statusCode, 204);
  });

  it("keeps a cash leg's amount and existence with its trade, but lets its memo, payee and status change", async () => {
    const broker = await account();
    const [fee] = await created({ type: "fee", accountId: broker, portfolioId: await portfolio(), tradeDate: "2026-01-10", feesCents: 700 });
    const legUrl = `/workspaces/${workspaceId}/accounts/${broker}/transactions/${fee!.cashTransactionId}`;

    const listed = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts/${broker}/transactions`, headers: await auth() });
    assert.equal(listed.json().transactions[0].tradeId, fee!.id);

    const amount = await app.fastify.inject({
      method: "PATCH",
      url: legUrl,
      headers: await auth(),
      payload: { splits: [{ categoryId: null, amountCents: -1 }] },
    });
    assert.equal(amount.statusCode, 409);
    assert.equal(amount.json().code, "trade_owned_transaction");

    const own = await app.fastify.inject({ method: "PATCH", url: legUrl, headers: await auth(), payload: { memo: "Custody Q1", payee: "Broker", status: "pending" } });
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().memo, "Custody Q1");
    assert.equal(own.json().payee, "Broker");
    assert.equal(own.json().status, "pending");
    assert.equal(own.json().splits[0].amountCents, -700);

    const removed = await app.fastify.inject({ method: "DELETE", url: legUrl, headers: await auth() });
    assert.equal(removed.statusCode, 409);
    assert.equal(removed.json().code, "trade_owned_transaction");

    // A reconciled leg locks its trade (#509 refuses editing and deleting it).
    await superuserPool.query("UPDATE transactions SET status = 'reconciled' WHERE id = $1", [fee!.cashTransactionId]);
    const [locked] = (await list(`?accountId=${broker}`)).json().trades as TradeBody[];
    assert.equal(locked!.locked, true);
  });

  it("refuses a synced change to a cash leg's account, date or amount, but applies its memo", async () => {
    const broker = await account();
    const [fee] = await created({ type: "fee", accountId: broker, portfolioId: await portfolio(), tradeDate: "2026-01-10", feesCents: 700 });
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM splits WHERE transaction_id = $1", [fee!.cashTransactionId]);
    const change = (entityId: string, fieldName: string, value: unknown) => ({
      id: randomUUID(),
      entityId,
      fieldName,
      hlc: { physical: Date.now(), counter: 0, deviceId: "phone" },
      value,
    });
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: await auth(),
      payload: {
        changes: [
          change(fee!.cashTransactionId!, "transactions.occurred_at", "2026-02-01T00:00:00Z"),
          change(fee!.cashTransactionId!, "transactions.account_id", randomUUID()),
          change(rows[0]!.id, "splits.amount_cents", -1),
          change(fee!.cashTransactionId!, "transactions.memo", "Synced memo"),
        ],
      },
    });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(
      response.json().results.map((result: { outcome: string }) => result.outcome),
      ["trade_owned", "trade_owned", "trade_owned", "applied"],
    );
  });

  it("keeps a brokerage account's balance at deposits plus its cash legs, and the budget month unchanged", async () => {
    const ws = await addWorkspace("owner");
    const checking = await account("checking", "EUR", ws);
    const broker = await account("brokerage", "EUR", ws);
    const growth = await portfolio(ws);
    const etf = await instrument();
    const headers = async () => await auth();
    const { rows: group } = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Savings', 1) RETURNING id",
      [ws],
    );
    const { rows: category } = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Investing', 1) RETURNING id",
      [ws, group[0]!.id],
    );
    const income = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${ws}/accounts/${checking}/transactions`,
      headers: await headers(),
      payload: { occurredAt: "2026-03-01", splits: [{ categoryId: null, amountCents: 500_000 }] },
    });
    assert.equal(income.statusCode, 201);
    const deposit = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${ws}/transfers`,
      headers: await headers(),
      payload: { sourceAccountId: checking, destinationAccountId: broker, occurredAt: "2026-03-02", amountCents: 300_000, categoryId: category[0]!.id },
    });
    assert.equal(deposit.statusCode, 201);

    const month = async () =>
      (await app.fastify.inject({ method: "GET", url: `/workspaces/${ws}/budget-months/2026-03`, headers: await headers() })).json();
    const budgetBefore = await month();

    const trades = [
      ...(await created({ type: "buy", accountId: broker, portfolioId: growth, instrumentId: etf, tradeDate: "2026-03-03", quantityE8: units(20), priceE6: price(100), feesCents: 500 }, ws)),
      ...(await created({ type: "sell", accountId: broker, portfolioId: growth, instrumentId: etf, tradeDate: "2026-03-10", quantityE8: units(5), priceE6: price(110), feesCents: 500, gainTaxCents: 1_200 }, ws)),
      ...(await created({ type: "dividend", accountId: broker, portfolioId: growth, instrumentId: etf, tradeDate: "2026-03-15", grossCents: 3_000, withholdingForeignCents: 450 }, ws)),
      ...(await created({ type: "fee", accountId: broker, portfolioId: growth, tradeDate: "2026-03-31", feesCents: 250 }, ws)),
      ...(await created({ type: "tax", taxKind: "stamp_duty", accountId: broker, portfolioId: growth, tradeDate: "2026-03-31", grossCents: 340 }, ws)),
      ...(await created({ type: "split", instrumentId: etf, tradeDate: "2026-03-20", splitFrom: 1, splitTo: 2 }, ws)),
    ];
    const cashLegs = trades.reduce((sum, trade) => sum + trade.cashCents, 0);
    assert.equal(cashLegs, -(200_000 + 500) + (55_000 - 500 - 1_200) + (3_000 - 450) - 250 - 340);

    const register = await app.fastify.inject({ method: "GET", url: `/workspaces/${ws}/accounts/${broker}/transactions`, headers: await headers() });
    const balance = (register.json().transactions as { splits: { amountCents: number }[] }[])
      .flatMap((transaction) => transaction.splits)
      .reduce((sum, split) => sum + split.amountCents, 0);
    assert.equal(balance, 300_000 + cashLegs);

    assert.deepEqual(await month(), budgetBefore);
  });

  describe("tax regimes (#508)", () => {
    let italian: string;
    let etf: string;
    let stock: string;
    let growth: string;

    async function regimeAccount(regimes: readonly [string, string][], agent: boolean | null): Promise<string> {
      const id = await account("brokerage", "EUR", italian, agent);
      for (const [validFrom, regime] of regimes) {
        await superuserPool.query("INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, $3, $4)", [
          italian,
          id,
          validFrom,
          regime,
        ]);
      }
      return id;
    }

    /** A sale of what was just bought, carrying `fields` (a gain tax, a withholding). */
    async function sell(accountId: string, instrumentId: string, tradeDate: string, fields: Record<string, unknown>) {
      const base = { accountId, portfolioId: growth, instrumentId, priceE6: price(100), quantityE8: units(1) };
      await created({ ...base, type: "buy", tradeDate: "2020-01-02" }, italian);
      return { ...base, type: "sell", tradeDate, ...fields };
    }

    before(async () => {
      italian = await addWorkspace("owner", "IT");
      etf = await instrument("fund");
      stock = await instrument("stock");
      growth = await portfolio(italian);
    });

    it("refuses a trade on an account with no regime history", async () => {
      const broker = await account("brokerage", "EUR", italian, false);
      const details = await rejected({ type: "fee", accountId: broker, portfolioId: growth, tradeDate: "2026-01-10", feesCents: 100 }, "tax_regime_required", italian);
      assert.equal(details.accountId, broker);
    });

    it("refuses gain tax in managed, and applies the first period to earlier dates too", async () => {
      const broker = await regimeAccount([["2026-06-15", "managed"]], true);
      const details = await rejected(await sell(broker, etf, "2025-03-01", { gainTaxCents: 100 }), "tax_kind_not_allowed_in_regime", italian);
      assert.deepEqual(details, { regime: "managed", field: "gainTaxCents" });
      await created(await sell(broker, etf, "2025-03-01", {}), italian);
    });

    it("uses the regime in force on the trade date", async () => {
      const broker = await regimeAccount([["2024-05-10", "administered"], ["2026-01-01", "managed"]], true);
      await created(await sell(broker, stock, "2025-12-31", { gainTaxCents: 100 }), italian);
      await rejected(await sell(broker, stock, "2026-01-01", { gainTaxCents: 100 }), "tax_kind_not_allowed_in_regime", italian);
    });

    it("allows managed_result_tax in managed only", async () => {
      const managed = await regimeAccount([["2026-01-01", "managed"]], true);
      const administered = await regimeAccount([["2026-01-01", "administered"]], true);
      const tax = { type: "tax", taxKind: "managed_result_tax", portfolioId: growth, tradeDate: "2026-12-31", grossCents: 900 };
      await created({ ...tax, accountId: managed }, italian);
      const details = await rejected({ ...tax, accountId: administered }, "tax_kind_not_allowed_in_regime", italian);
      assert.deepEqual(details, { regime: "administered", field: "taxKind", taxKind: "managed_result_tax" });
    });

    it("allows gain tax in self_declared only on a fund at a domestic withholding agent", async () => {
      const agent = await regimeAccount([["2026-01-01", "self_declared"]], true);
      const foreign = await regimeAccount([["2026-01-01", "self_declared"]], false);
      await created(await sell(agent, etf, "2026-02-01", { gainTaxCents: 100 }), italian);
      await rejected(await sell(agent, stock, "2026-02-01", { gainTaxCents: 100 }), "tax_kind_not_allowed_in_regime", italian);
      await rejected(await sell(foreign, etf, "2026-02-01", { gainTaxCents: 100 }), "tax_kind_not_allowed_in_regime", italian);
    });

    it("accepts a dividend's domestic withholding at a foreign broker: it was taken upstream", async () => {
      const foreign = await regimeAccount([["2026-01-01", "self_declared"]], false);
      // An Italian share's dividend: €100 gross, €26 withheld in Italy, €74 paid in.
      const [dividend] = await created(
        { type: "dividend", accountId: foreign, portfolioId: growth, instrumentId: stock, tradeDate: "2026-03-01", grossCents: 10_000, withholdingDomesticCents: 2_600 },
        italian,
      );
      assert.equal(dividend!.cashCents, 7_400);
    });

    it("refuses the domestic withholding on a bond trade's accrued interest unless the broker is a domestic withholding agent", async () => {
      const bond = await instrument("government_bond", "EUR", 10_000);
      const agent = await regimeAccount([["2026-01-01", "self_declared"]], true);
      const foreign = await regimeAccount([["2026-01-01", "self_declared"]], false);
      const buy = { type: "buy", portfolioId: growth, instrumentId: bond, tradeDate: "2026-03-01", quantityE8: units(1_000), priceE6: price(99), accruedInterestCents: 300, withholdingDomesticCents: 37 };
      await created({ ...buy, accountId: agent }, italian);
      const details = await rejected({ ...buy, accountId: foreign }, "domestic_withholding_requires_agent", italian);
      assert.deepEqual(details, { field: "withholdingDomesticCents" });
    });

    it("allows a gain tax adjustment when an earlier regime allowed gain tax", async () => {
      // An administered sale in December, self-declared from 1 January, a refund in February.
      const broker = await regimeAccount([["2025-03-10", "administered"], ["2026-01-01", "self_declared"]], true);
      await created(await sell(broker, stock, "2025-12-15", { gainTaxCents: 300 }), italian);
      const [refund] = await created(
        { type: "tax", taxKind: "gain_tax_adjustment", accountId: broker, portfolioId: growth, instrumentId: stock, tradeDate: "2026-02-10", grossCents: 300 },
        italian,
      );
      assert.equal(refund!.cashCents, 300);
      // Only ever self-declared: an adjustment must name a fund.
      const selfDeclared = await regimeAccount([["2026-01-01", "self_declared"]], true);
      const adjustment = { type: "tax", taxKind: "gain_tax_adjustment", accountId: selfDeclared, portfolioId: growth, tradeDate: "2026-02-10", grossCents: 300 };
      await rejected({ ...adjustment, instrumentId: stock }, "tax_kind_not_allowed_in_regime", italian);
      await created({ ...adjustment, instrumentId: etf }, italian);
    });

    it("checks nothing outside an IT workspace", async () => {
      // The main workspace has no tax country: no regime, gain tax on a stock, no withholding agent.
      const broker = await account();
      const base = { accountId: broker, portfolioId: await portfolio(), instrumentId: stock, priceE6: price(100), quantityE8: units(1) };
      await created({ ...base, type: "buy", tradeDate: "2026-01-02" });
      await created({ ...base, type: "sell", tradeDate: "2026-02-02", gainTaxCents: 100 });
    });
  });

  describe("editing and deleting (#509)", () => {
    async function patch(tradeId: string, payload: Record<string, unknown>, ws = workspaceId) {
      return app.fastify.inject({ method: "PATCH", url: `/workspaces/${ws}/trades/${tradeId}`, headers: await auth(), payload });
    }

    async function remove(tradeId: string, ws = workspaceId) {
      return app.fastify.inject({ method: "DELETE", url: `/workspaces/${ws}/trades/${tradeId}`, headers: await auth() });
    }

    async function edited(tradeId: string, payload: Record<string, unknown>, ws = workspaceId): Promise<TradeBody[]> {
      const response = await patch(tradeId, payload, ws);
      assert.equal(response.statusCode, 200, response.body);
      return response.json().trades;
    }

    /** The trades of the workspace, as stored, and their cash legs: what a refused request must leave untouched. */
    async function snapshot(ws = workspaceId) {
      const { rows } = await superuserPool.query(
        `SELECT t.*, c.id AS leg_id, c.account_id AS leg_account, c.occurred_at AS leg_date,
                (SELECT sum(amount_cents) FROM splits WHERE transaction_id = c.id) AS leg_amount
         FROM trades t LEFT JOIN transactions c ON c.trade_id = t.id
         WHERE t.workspace_id = $1 ORDER BY t.id`,
        [ws],
      );
      return rows;
    }

    async function refusedEdit(tradeId: string, payload: Record<string, unknown>, code: string, ws = workspaceId): Promise<Record<string, unknown>> {
      const before = await snapshot(ws);
      const response = await patch(tradeId, payload, ws);
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error, code, response.body);
      assert.deepEqual(await snapshot(ws), before);
      return response.json().details;
    }

    async function refusedDelete(tradeId: string, code: string, ws = workspaceId): Promise<Record<string, unknown>> {
      const before = await snapshot(ws);
      const response = await remove(tradeId, ws);
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error, code, response.body);
      assert.deepEqual(await snapshot(ws), before);
      return response.json().details;
    }

    async function balanceOf(accountId: string): Promise<number> {
      const { rows } = await superuserPool.query<{ balance: string | null }>(
        "SELECT sum(s.amount_cents) AS balance FROM splits s JOIN transactions t ON t.id = s.transaction_id WHERE t.account_id = $1",
        [accountId],
      );
      return Number(rows[0]!.balance ?? 0);
    }

    async function legCount(tradeId: string): Promise<number> {
      const { rows } = await superuserPool.query<{ count: string }>("SELECT count(*) FROM transactions WHERE trade_id = $1", [tradeId]);
      return Number(rows[0]!.count);
    }

    it("rewrites a buy and its cash leg in place, keeping the leg's id, memo and payee", async () => {
      const etf = await instrument();
      const broker = await account();
      const growth = await portfolio();
      const [buy] = await created({ type: "buy", accountId: broker, portfolioId: growth, instrumentId: etf, tradeDate: "2026-03-02", quantityE8: units(10), priceE6: price(100), feesCents: 500 });
      await superuserPool.query("UPDATE transactions SET memo = 'Plan', payee = 'Broker', status = 'cleared' WHERE id = $1", [buy!.cashTransactionId]);

      const [after] = await edited(buy!.id, { feesCents: 700, tradeDate: "2026-03-03", memo: "Corrected" });
      assert.equal(after!.id, buy!.id);
      assert.equal(after!.feesCents, 700);
      assert.equal(after!.grossCents, 100_000);
      assert.equal(after!.cashCents, -100_700);
      assert.equal(after!.memo, "Corrected");
      assert.equal(after!.createdAt, buy!.createdAt);
      assert.equal(after!.cashTransactionId, buy!.cashTransactionId);
      const leg = await legOf(after!);
      assert.equal(leg!.amount_cents, "-100700");
      assert.equal(leg!.local_date, "2026-03-03 00:00");
      assert.equal(leg!.account_id, broker);
      // Its amount and date changed: no longer what was ticked against the statement.
      assert.equal(leg!.status, "pending");
      const { rows } = await superuserPool.query<{ memo: string; payee: string }>("SELECT memo, payee FROM transactions WHERE id = $1", [after!.cashTransactionId]);
      assert.deepEqual({ ...rows[0] }, { memo: "Plan", payee: "Broker" });

      const { rows: audit } = await superuserPool.query<{ before: { trades: TradeBody[] }; after: { trades: TradeBody[] } }>(
        "SELECT before, after FROM audit_log WHERE workspace_id = $1 AND action = 'trade.update' ORDER BY created_at DESC LIMIT 1",
        [workspaceId],
      );
      assert.equal(audit[0]!.before.trades[0]!.feesCents, 500);
      assert.equal(audit[0]!.after.trades[0]!.feesCents, 700);

      // occurredAt and memo can be cleared.
      const [cleared] = await edited(buy!.id, { memo: null, occurredAt: null });
      assert.equal(cleared!.memo, null);
    });

    it("sends a cleared cash leg back to pending when its amount, account or date changes, and only then", async () => {
      const etf = await instrument();
      const [broker, other] = [await account(), await account()];
      const growth = await portfolio();
      const [dividend] = await created({ type: "dividend", accountId: broker, portfolioId: growth, instrumentId: etf, tradeDate: "2026-04-01", grossCents: 1_000 });
      const clear = () => superuserPool.query("UPDATE transactions SET status = 'cleared' WHERE id = $1", [dividend!.cashTransactionId]);
      const statusAfter = async (payload: Record<string, unknown>) => {
        await clear();
        await edited(dividend!.id, payload);
        return (await legOf(dividend!))!.status;
      };

      // The leg unchanged: the memo, the time, the portfolio, or a gross that nets to the same cash.
      assert.equal(await statusAfter({ memo: "Q1 dividend" }), "cleared");
      assert.equal(await statusAfter({ occurredAt: "2026-04-01T09:00:00+02:00" }), "cleared");
      assert.equal(await statusAfter({ portfolioId: await portfolio() }), "cleared");
      assert.equal(await statusAfter({ grossCents: 1_100, feesCents: 100 }), "cleared");

      // The leg changed: its amount, its account, its date.
      assert.equal(await statusAfter({ grossCents: 1_200 }), "pending");
      assert.equal(await statusAfter({ accountId: other }), "pending");
      assert.equal(await statusAfter({ tradeDate: "2026-04-02", occurredAt: null }), "pending");

      // A pending leg stays pending either way.
      await superuserPool.query("UPDATE transactions SET status = 'pending' WHERE id = $1", [dividend!.cashTransactionId]);
      await edited(dividend!.id, { memo: "still pending" });
      assert.equal((await legOf(dividend!))!.status, "pending");
    });

    it("computes the gross again when the quantity or the price changes without one, and keeps one given", async () => {
      const etf = await instrument();
      const base = { type: "buy", accountId: await account(), portfolioId: await portfolio(), instrumentId: etf, tradeDate: "2026-03-02" };
      const [buy] = await created({ ...base, quantityE8: units(10), priceE6: price(100), grossCents: 100_003 });
      assert.equal((await edited(buy!.id, { memo: "unchanged gross" }))[0]!.grossCents, 100_003);
      assert.equal((await edited(buy!.id, { quantityE8: units(5) }))[0]!.grossCents, 50_000);
      const [given] = await edited(buy!.id, { priceE6: price(90), grossCents: 45_001 });
      assert.equal(given!.grossCents, 45_001);
      assert.equal(given!.cashCents, -45_001);
    });

    it("creates the cash leg when an amount becomes non-zero, and deletes it when it becomes zero", async () => {
      const etf = await instrument();
      const broker = await account();
      const [from, to] = [await portfolio(), await portfolio()];
      await created({ type: "buy", accountId: broker, portfolioId: from, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(10), priceE6: price(100) });
      const legs = await created({ type: "transfer", instrumentId: etf, tradeDate: "2026-02-01", quantityE8: units(4), from: { accountId: broker, portfolioId: from }, to: { accountId: broker, portfolioId: to } });
      const outgoing = legs.find((leg) => leg.quantityE8 < 0)!;
      assert.equal(outgoing.cashTransactionId, null);
      const balance = await balanceOf(broker);

      // 0 → an amount: the leg is created.
      const withFees = await edited(outgoing.id, { from: { feesCents: 300 } });
      const paying = withFees.find((leg) => leg.id === outgoing.id)!;
      assert.equal(paying.cashCents, -300);
      assert.ok(paying.cashTransactionId);
      assert.deepEqual(await legOf(paying), {
        account_id: broker,
        status: "pending",
        trade_id: outgoing.id,
        local_date: "2026-02-01 00:00",
        amount_cents: "-300",
        category_id: null,
        split_count: "1",
      });
      assert.equal(await balanceOf(broker), balance - 300);

      // An amount → 0: the leg is deleted.
      const free = await edited(outgoing.id, { from: { feesCents: 0 } });
      assert.equal(free.find((leg) => leg.id === outgoing.id)!.cashTransactionId, null);
      assert.equal(await legCount(outgoing.id), 0);
      assert.equal(await balanceOf(broker), balance);
    });

    it("moves the cash leg with a trade moved to another account", async () => {
      const etf = await instrument();
      const [first, second] = [await account(), await account()];
      const growth = await portfolio();
      const [dividend] = await created({ type: "dividend", accountId: first, portfolioId: growth, instrumentId: etf, tradeDate: "2026-04-01", grossCents: 1_000, withholdingForeignCents: 150 });
      const [moved] = await edited(dividend!.id, { accountId: second, grossCents: 1_200 });
      assert.equal(moved!.accountId, second);
      assert.equal(moved!.cashTransactionId, dividend!.cashTransactionId);
      assert.equal((await legOf(moved!))!.account_id, second);
      assert.equal(await balanceOf(first), 0);
      assert.equal(await balanceOf(second), 1_050);

      // A move the account cannot take is refused: not a brokerage account, or another workspace's.
      await refusedEdit(dividend!.id, { accountId: await account("checking") }, "account_not_brokerage");
      const foreign = await account("brokerage", "EUR", await addWorkspace("owner"));
      await refusedEdit(dividend!.id, { accountId: foreign }, "unknown_account");
      await refusedEdit(dividend!.id, { portfolioId: await portfolio(await addWorkspace("owner")) }, "unknown_portfolio");
    });

    it("refuses an edit that would make a holding negative at any date: a backdated sale, a smaller buy, a buy moved away", async () => {
      const etf = await instrument();
      const [broker, other] = [await account(), await account()];
      const growth = await portfolio();
      const base = { accountId: broker, portfolioId: growth, instrumentId: etf, priceE6: price(10) };
      const [buy] = await created({ ...base, type: "buy", tradeDate: "2026-01-10", quantityE8: units(10) });
      const [sale] = await created({ ...base, type: "sell", tradeDate: "2026-03-10", quantityE8: units(8) });

      const backdated = await refusedEdit(sale!.id, { tradeDate: "2026-01-05" }, "insufficient_quantity");
      assert.equal(backdated.date, "2026-01-05");
      const smaller = await refusedEdit(buy!.id, { quantityE8: units(5) }, "insufficient_quantity");
      assert.deepEqual([smaller.date, smaller.available, smaller.requested], ["2026-03-10", units(5), units(8)]);
      await refusedEdit(buy!.id, { accountId: other }, "insufficient_quantity");
      await refusedEdit(buy!.id, { portfolioId: await portfolio() }, "insufficient_quantity");
      await refusedEdit(buy!.id, { instrumentId: await instrument() }, "insufficient_quantity");
      await refusedEdit(buy!.id, { instrumentId: await instrument("fund", "USD") }, "currency_mismatch");
      await refusedEdit(buy!.id, { instrumentId: randomUUID() }, "unknown_instrument");

      // The same edits pass once the sale is gone with them.
      assert.equal((await remove(sale!.id)).statusCode, 204);
      const [moved] = await edited(buy!.id, { accountId: other, quantityE8: units(5) });
      assert.equal(moved!.accountId, other);
    });

    it("refuses deleting a buy a later sale depends on, and deletes a trade with its cash leg", async () => {
      const etf = await instrument();
      const broker = await account();
      const growth = await portfolio();
      const base = { accountId: broker, portfolioId: growth, instrumentId: etf, priceE6: price(10) };
      const [old] = await created({ ...base, type: "buy", tradeDate: "2025-06-10", quantityE8: units(5) });
      await created({ ...base, type: "buy", tradeDate: "2026-01-10", quantityE8: units(5) });
      await created({ ...base, type: "sell", tradeDate: "2026-02-10", quantityE8: units(8) });

      const details = await refusedDelete(old!.id, "insufficient_quantity");
      assert.deepEqual([details.portfolioId, details.date, details.available, details.requested], [growth, "2026-02-10", units(5), units(8)]);

      const [fee] = await created({ type: "fee", accountId: broker, portfolioId: growth, tradeDate: "2026-03-01", feesCents: 250 });
      const response = await remove(fee!.id);
      assert.equal(response.statusCode, 204);
      assert.equal(await legCount(fee!.id), 0);
      const { rows } = await superuserPool.query("SELECT 1 FROM transactions WHERE id = $1", [fee!.cashTransactionId]);
      assert.equal(rows.length, 0);
      const { rows: audit } = await superuserPool.query<{ before: { trades: TradeBody[] }; after: unknown }>(
        "SELECT before, after FROM audit_log WHERE workspace_id = $1 AND action = 'trade.delete' ORDER BY created_at DESC LIMIT 1",
        [workspaceId],
      );
      assert.equal(audit[0]!.before.trades[0]!.id, fee!.id);
      assert.equal(audit[0]!.after, null);
      assert.equal((await remove(fee!.id)).statusCode, 404);
    });

    it("edits and deletes both legs of a transfer together, through either leg", async () => {
      const etf = await instrument();
      const [source, target] = [await account(), await account()];
      const growth = await portfolio();
      await created({ type: "buy", accountId: source, portfolioId: growth, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(10), priceE6: price(100) });
      const legs = await created({ type: "transfer", instrumentId: etf, tradeDate: "2026-02-01", quantityE8: units(5), from: { accountId: source, portfolioId: growth, feesCents: 900 }, to: { accountId: target, portfolioId: growth } });
      const outgoing = legs.find((leg) => leg.quantityE8 < 0)!;
      const incoming = legs.find((leg) => leg.quantityE8 > 0)!;

      const both = await edited(incoming.id, { quantityE8: units(6), tradeDate: "2026-02-02", to: { feesCents: 100 } });
      assert.deepEqual(both.map((leg) => [leg.id, leg.quantityE8, leg.tradeDate, leg.cashCents]).sort(), [
        [outgoing.id, -units(6), "2026-02-02", -900],
        [incoming.id, units(6), "2026-02-02", -100],
      ].sort());
      assert.equal((await legOf(both.find((leg) => leg.id === outgoing.id)!))!.local_date, "2026-02-02 00:00");
      assert.equal((await legOf(both.find((leg) => leg.id === incoming.id)!))!.account_id, target);

      await refusedEdit(outgoing.id, { quantityE8: units(11) }, "insufficient_quantity");
      assert.equal((await refusedEdit(outgoing.id, { to: { accountId: source } }, "invalid_trade")).field, "to");
      assert.equal((await refusedEdit(outgoing.id, { accountId: target }, "invalid_trade")).field, "accountId");

      // The units moved are sold from the target: deleting the transfer would leave that sale short.
      const [sale] = await created({ type: "sell", accountId: target, portfolioId: growth, instrumentId: etf, tradeDate: "2026-03-01", quantityE8: units(6), priceE6: price(100) });
      await refusedDelete(outgoing.id, "insufficient_quantity");
      assert.equal((await remove(sale!.id)).statusCode, 204);
      assert.equal((await remove(outgoing.id)).statusCode, 204);
      const { rows } = await superuserPool.query("SELECT 1 FROM trades WHERE id = ANY($1)", [[outgoing.id, incoming.id]]);
      assert.equal(rows.length, 0);
      assert.equal(await legCount(outgoing.id), 0);
      assert.equal(await legCount(incoming.id), 0);
    });

    it("edits and deletes every row of a split together", async () => {
      const etf = await instrument();
      const [first, second] = [await account(), await account()];
      const [growth, income] = [await portfolio(), await portfolio()];
      const buy = { type: "buy", instrumentId: etf, priceE6: price(100) };
      await created({ ...buy, accountId: first, portfolioId: growth, tradeDate: "2026-01-10", quantityE8: units(10) });
      await created({ ...buy, accountId: second, portfolioId: income, tradeDate: "2026-03-10", quantityE8: units(4) });
      const split = await created({ type: "split", instrumentId: etf, tradeDate: "2026-04-01", splitFrom: 1, splitTo: 2 });
      assert.equal(split.length, 2);

      const ratio = await edited(split[1]!.id, { splitTo: 3, memo: "1:3" });
      assert.deepEqual(ratio.map((row) => [row.id, row.splitTo, row.memo]).sort(), split.map((row) => [row.id, 3, "1:3"]).sort());

      // Moved before the second holding began: it covers the first holding only, keeping its row.
      const earlier = await edited(split[0]!.id, { tradeDate: "2026-02-01" });
      const kept = split.find((row) => row.accountId === first)!;
      assert.deepEqual(earlier.map((row) => [row.id, row.accountId, row.tradeDate]), [[kept.id, first, "2026-02-01"]]);
      const { rows: left } = await superuserPool.query("SELECT 1 FROM trades WHERE type = 'split' AND instrument_id = $1", [etf]);
      assert.equal(left.length, 1);

      // 10 units are 30 after the split; a sale of 25 needs it.
      const [sale] = await created({ ...buy, type: "sell", accountId: first, portfolioId: growth, tradeDate: "2026-05-01", quantityE8: units(25) });
      await refusedDelete(kept.id, "insufficient_quantity");
      await refusedEdit(kept.id, { splitTo: 2 }, "insufficient_quantity");
      assert.equal((await refusedEdit(kept.id, { accountId: second }, "invalid_trade")).field, "accountId");
      assert.equal((await remove(sale!.id)).statusCode, 204);
      assert.equal((await remove(kept.id)).statusCode, 204);
      const { rows: none } = await superuserPool.query("SELECT 1 FROM trades WHERE type = 'split' AND instrument_id = $1", [etf]);
      assert.equal(none.length, 0);
    });

    it("refuses to edit or delete a trade whose cash leg is reconciled, or the other leg of its transfer", async () => {
      const etf = await instrument();
      const [source, target] = [await account(), await account()];
      const growth = await portfolio();
      const [fee] = await created({ type: "fee", accountId: source, portfolioId: growth, tradeDate: "2026-01-10", feesCents: 700 });
      await created({ type: "buy", accountId: source, portfolioId: growth, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(10), priceE6: price(100) });
      const legs = await created({ type: "transfer", instrumentId: etf, tradeDate: "2026-02-01", quantityE8: units(5), from: { accountId: source, portfolioId: growth, feesCents: 900 }, to: { accountId: target, portfolioId: growth } });
      const outgoing = legs.find((leg) => leg.quantityE8 < 0)!;
      const incoming = legs.find((leg) => leg.quantityE8 > 0)!;
      await superuserPool.query("UPDATE transactions SET status = 'reconciled' WHERE id = ANY($1)", [[fee!.cashTransactionId, outgoing.cashTransactionId]]);

      const before = await snapshot();
      for (const response of [await patch(fee!.id, { feesCents: 800 }), await remove(fee!.id), await patch(incoming.id, { memo: "x" }), await remove(incoming.id)]) {
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().code, "reconciled");
      }
      assert.deepEqual(await snapshot(), before);

      // Unlocked, the same edit goes through.
      await superuserPool.query("UPDATE transactions SET status = 'cleared' WHERE id = $1", [fee!.cashTransactionId]);
      assert.equal((await edited(fee!.id, { feesCents: 800 }))[0]!.cashCents, -800);
    });

    it("runs the entry checks and the regime checks on the edited trade", async () => {
      const etf = await instrument();
      const stock = await instrument("stock");
      const base = { accountId: await account(), portfolioId: await portfolio(), priceE6: price(10), quantityE8: units(1) };
      const [buy] = await created({ ...base, type: "buy", instrumentId: etf, tradeDate: "2026-01-10" });
      assert.equal((await refusedEdit(buy!.id, { feesCents: -1 }, "negative_amount_not_allowed")).field, "feesCents");
      await refusedEdit(buy!.id, { accruedInterestCents: 10 }, "accrued_interest_not_allowed");
      assert.equal((await refusedEdit(buy!.id, { gainTaxCents: 10 }, "invalid_trade")).field, "gainTaxCents");
      assert.equal((await refusedEdit(buy!.id, { type: "sell", memo: "now a sale" }, "invalid_trade")).field, "type");
      assert.equal((await refusedEdit(buy!.id, { instrumentId: null }, "invalid_trade")).field, "instrumentId");
      assert.equal((await refusedEdit(buy!.id, { occurredAt: "2026-01-11T10:00:00+01:00" }, "invalid_trade")).field, "occurredAt");
      assert.equal((await edited(buy!.id, { type: "buy", instrumentId: stock }))[0]!.instrumentId, stock);

      const italian = await addWorkspace("owner", "IT");
      const managed = await account("brokerage", "EUR", italian, true);
      await superuserPool.query("INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2026-01-01', 'managed')", [italian, managed]);
      const growth = await portfolio(italian);
      const trade = { accountId: managed, portfolioId: growth, instrumentId: etf, priceE6: price(10), quantityE8: units(1) };
      await created({ ...trade, type: "buy", tradeDate: "2026-01-10" }, italian);
      const [sale] = await created({ ...trade, type: "sell", tradeDate: "2026-02-10" }, italian);
      const details = await refusedEdit(sale!.id, { gainTaxCents: 100 }, "tax_kind_not_allowed_in_regime", italian);
      assert.deepEqual(details, { regime: "managed", field: "gainTaxCents" });
    });

    it("refuses a body that cannot be read as an edit", async () => {
      const [fee] = await created({ type: "fee", accountId: await account(), portfolioId: await portfolio(), tradeDate: "2026-01-10", feesCents: 100 });
      for (const payload of [{ id: randomUUID() }, { feesCents: "1" }, { colour: "red" }, { accountId: "nope" }, { from: { id: randomUUID() } }, { taxKind: "vat" }]) {
        const response = await patch(fee!.id, payload);
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
        assert.match(response.json().error, /^invalid trade: /);
      }
      const long = await patch(fee!.id, { memo: "x".repeat(MAX_FREE_TEXT_LENGTH + 1) });
      assert.equal(long.statusCode, 400);
      assert.equal(long.json().error, "text_too_long");
    });

    it("lets owners and editors edit and delete, not read_only members", async () => {
      const broker = await account();
      const growth = await portfolio();
      const [fee] = await created({ type: "fee", accountId: broker, portfolioId: growth, tradeDate: "2026-01-10", feesCents: 100 });
      try {
        await setRole("read_only");
        assert.equal((await patch(fee!.id, { feesCents: 200 })).statusCode, 403);
        assert.equal((await remove(fee!.id)).statusCode, 403);
        await setRole("editor");
        assert.equal((await patch(fee!.id, { feesCents: 200 })).statusCode, 200);
        assert.equal((await remove(fee!.id)).statusCode, 204);
      } finally {
        await setRole("owner");
      }
    });

    it("answers 404 for another workspace's trade, an unknown id and a malformed one", async () => {
      const other = await addWorkspace("owner");
      const [foreign] = await created({ type: "fee", accountId: await account("brokerage", "EUR", other), portfolioId: await portfolio(other), tradeDate: "2026-01-10", feesCents: 100 }, other);
      for (const id of [foreign!.id, randomUUID(), "not-a-uuid"]) {
        const edit = await patch(id, { feesCents: 200 });
        assert.equal(edit.statusCode, 404, edit.body);
        assert.equal(edit.json().error, "trade not found");
        assert.equal((await remove(id)).statusCode, 404);
      }
      const { rows } = await superuserPool.query<{ fees_cents: string }>("SELECT fees_cents FROM trades WHERE id = $1", [foreign!.id]);
      assert.equal(rows[0]!.fees_cents, "100");
    });

    it("serializes an edit racing a sale, so together they cannot oversell", async () => {
      const etf = await instrument();
      const broker = await account();
      const growth = await portfolio();
      const base = { accountId: broker, portfolioId: growth, instrumentId: etf, priceE6: price(10) };
      for (let round = 0; round < 5; round++) {
        const [buy] = await created({ ...base, type: "buy", tradeDate: "2026-01-10", quantityE8: units(10) });
        const responses = await Promise.all([
          patch(buy!.id, { quantityE8: units(4) }),
          post({ ...base, type: "sell", tradeDate: "2026-02-10", quantityE8: units(7) }),
        ]);
        const statuses = responses.map((response) => response.statusCode);
        assert.equal(statuses.filter((status) => status === 400).length, 1, statuses.join());
        assert.equal(responses.find((response) => response.statusCode === 400)!.json().error, "insufficient_quantity");

        const { rows } = await superuserPool.query<{ held: string }>(
          "SELECT sum(CASE WHEN type = 'sell' THEN -quantity_e8 ELSE quantity_e8 END) AS held FROM trades WHERE account_id = $1",
          [broker],
        );
        assert.ok(Number(rows[0]!.held) >= 0);
        // Back to an empty holding for the next round.
        await superuserPool.query("DELETE FROM trades WHERE account_id = $1", [broker]);
      }
    });

    it("clears the instrument of a fee and of a tax, keeping the trade's cash leg", async () => {
      const etf = await instrument();
      const broker = await account();
      const growth = await portfolio();
      const [fee] = await created({ type: "fee", accountId: broker, portfolioId: growth, instrumentId: etf, tradeDate: "2026-05-01", feesCents: 250 });
      const [tax] = await created({ type: "tax", taxKind: "other", accountId: broker, portfolioId: growth, instrumentId: etf, tradeDate: "2026-05-01", grossCents: 340 });
      for (const [trade, cash] of [[fee!, -250], [tax!, -340]] as const) {
        const [cleared] = await edited(trade.id, { instrumentId: null });
        assert.equal(cleared!.instrumentId, null);
        assert.equal(cleared!.cashCents, cash);
        assert.equal(cleared!.cashTransactionId, trade.cashTransactionId);
        const leg = await legOf(cleared!);
        assert.deepEqual([leg!.account_id, leg!.amount_cents, leg!.local_date], [broker, String(cash), "2026-05-01 00:00"]);
        const { rows } = await superuserPool.query<{ instrument_id: string | null }>("SELECT instrument_id FROM trades WHERE id = $1", [trade.id]);
        assert.equal(rows[0]!.instrument_id, null);
        // And back onto the instrument.
        assert.equal((await edited(trade.id, { instrumentId: etf }))[0]!.instrumentId, etf);
      }
    });

    it("locks one history whatever the case of the workspace id, so an upper-case request cannot oversell", async () => {
      const etf = await instrument();
      const broker = await account();
      const growth = await portfolio();
      const base = { accountId: broker, portfolioId: growth, instrumentId: etf, priceE6: price(10) };
      for (let round = 0; round < 5; round++) {
        const [buy] = await created({ ...base, type: "buy", tradeDate: "2026-01-10", quantityE8: units(10) });
        const sale = { ...base, type: "sell", tradeDate: "2026-02-10", quantityE8: units(6) };
        const responses = await Promise.all([post(sale, workspaceId.toUpperCase()), post(sale, workspaceId)]);
        assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 400]);
        // An edit through the upper-case id races a sale through the lower-case one.
        await superuserPool.query("DELETE FROM trades WHERE account_id = $1 AND type = 'sell'", [broker]);
        const raced = await Promise.all([patch(buy!.id, { quantityE8: units(4) }, workspaceId.toUpperCase()), post({ ...sale, quantityE8: units(7) })]);
        assert.equal(raced.filter((response) => response.statusCode === 400).length, 1, raced.map((response) => response.statusCode).join());
        await superuserPool.query("DELETE FROM trades WHERE account_id = $1", [broker]);
      }
    });

    it("answers 409 concurrent_change when another request moved the trade to another instrument while it waited", async () => {
      const [first, second] = [await instrument(), await instrument()];
      const broker = await account();
      const [fee] = await created({ type: "fee", accountId: broker, portfolioId: await portfolio(), instrumentId: first, tradeDate: "2026-05-01", feesCents: 100 });

      // Hold the first instrument's history lock, as a concurrent request would.
      const holder = await superuserPool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`trades:${workspaceId}:${first}`]);
        const pending = patch(fee!.id, { memo: "waiting" });
        // Once the edit waits on that lock, the trade moves to the second instrument and commits.
        for (let attempt = 0; ; attempt++) {
          const { rows } = await superuserPool.query(
            `SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'
               AND query LIKE '%pg_advisory_xact_lock%'`,
          );
          if (rows.length > 0) break;
          assert.ok(attempt < 200, "the edit never waited on the lock");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await superuserPool.query("UPDATE trades SET instrument_id = $1 WHERE id = $2", [second, fee!.id]);
        await holder.query("COMMIT");
        const response = await pending;
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().code, "concurrent_change");
      } finally {
        holder.release();
      }
      // Nothing was written; a retry goes through.
      const { rows } = await superuserPool.query<{ memo: string | null }>("SELECT memo FROM trades WHERE id = $1", [fee!.id]);
      assert.equal(rows[0]!.memo, null);
      assert.equal((await edited(fee!.id, { memo: "retried" }))[0]!.memo, "retried");
    });

    it("refuses a body that is not a JSON object, and an edit that changes nothing, writing no audit entry", async () => {
      const broker = await account();
      const [fee] = await created({ type: "fee", accountId: broker, portfolioId: await portfolio(), tradeDate: "2026-05-01", feesCents: 100 });
      const json = { "content-type": "application/json" };
      for (const raw of ["[]", '"a fee"', "123", "null"]) {
        for (const [method, url] of [
          ["POST", `/workspaces/${workspaceId}/trades`],
          ["PATCH", `/workspaces/${workspaceId}/trades/${fee!.id}`],
        ] as const) {
          const response = await app.fastify.inject({ method, url, headers: { ...(await auth()), ...json }, payload: raw });
          assert.equal(response.statusCode, 400, `${method} ${raw}: ${response.body}`);
          assert.equal(response.json().error, "invalid trade: the body must be a JSON object", `${method} ${raw}`);
        }
      }

      const audits = async () =>
        Number((await superuserPool.query<{ count: string }>("SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = 'trade.update'", [workspaceId])).rows[0]!.count);
      const before = await audits();
      for (const payload of [{}, { type: "fee" }, { from: null, to: null }]) {
        const response = await patch(fee!.id, payload);
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
        assert.equal(response.json().error, "invalid trade: nothing to change");
      }
      assert.equal(await audits(), before);
    });

    describe("archived portfolios (#597)", () => {
      async function setArchived(portfolioId: string, archived: boolean): Promise<void> {
        const response = await app.fastify.inject({
          method: "PATCH",
          url: `/workspaces/${workspaceId}/portfolios/${portfolioId}`,
          headers: await auth(),
          payload: { archived },
        });
        assert.equal(response.statusCode, 200, response.body);
      }

      it("refuses every type of new trade in an archived portfolio, and accepts them again once unarchived", async () => {
        const etf = await instrument();
        const broker = await account();
        const held = await portfolio();
        await created({ type: "buy", accountId: broker, portfolioId: held, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(10), priceE6: price(100) });
        await setArchived(held, true);

        const base = { accountId: broker, portfolioId: held, tradeDate: "2026-02-01" };
        const attempts: Record<string, unknown>[] = [
          { ...base, type: "buy", instrumentId: etf, quantityE8: units(1), priceE6: price(100) },
          { ...base, type: "sell", instrumentId: etf, quantityE8: units(1), priceE6: price(100) },
          { ...base, type: "dividend", instrumentId: etf, grossCents: 1_000 },
          { ...base, type: "fee", feesCents: 100 },
          { ...base, type: "tax", taxKind: "stamp_duty", grossCents: 200 },
        ];
        for (const attempt of attempts) {
          const details = await rejected(attempt, "portfolio_archived");
          assert.deepEqual(details, { portfolioId: held }, String(attempt.type));
        }

        await setArchived(held, false);
        for (const attempt of attempts) {
          await created(attempt);
        }
      });

      it("refuses a transfer into an archived portfolio, but lets one empty it", async () => {
        const etf = await instrument();
        const [broker, other] = [await account(), await account()];
        const [active, archived] = [await portfolio(), await portfolio()];
        const buy = { type: "buy", accountId: broker, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(10), priceE6: price(100) };
        await created({ ...buy, portfolioId: active });
        await created({ ...buy, portfolioId: archived });
        await setArchived(archived, true);

        const transfer = { type: "transfer", instrumentId: etf, tradeDate: "2026-02-01", quantityE8: units(2) };
        const into = await rejected({ ...transfer, from: { accountId: broker, portfolioId: active }, to: { accountId: broker, portfolioId: archived } }, "portfolio_archived");
        assert.equal(into.portfolioId, archived);
        // A transfer in from outside the app has only the incoming leg.
        await rejected({ ...transfer, to: { accountId: broker, portfolioId: archived, costBasisCents: 20_000 } }, "portfolio_archived");

        // Out of it: to another portfolio, to another account, and out of the app, until it is empty.
        const toPortfolio = await created({ ...transfer, from: { accountId: broker, portfolioId: archived }, to: { accountId: broker, portfolioId: active } });
        assert.equal(toPortfolio.length, 2);
        const toAccount = await created({ ...transfer, from: { accountId: broker, portfolioId: archived, feesCents: 300 }, to: { accountId: other, portfolioId: active } });
        assert.equal(toAccount.find((leg) => leg.portfolioId === archived)!.cashCents, -300);
        const [outOfApp] = await created({ ...transfer, quantityE8: units(6), from: { accountId: broker, portfolioId: archived } });
        assert.equal(outOfApp!.quantityE8, -units(6));
      });

      it("refuses a transfer from one archived portfolio into another, naming the receiving one", async () => {
        const etf = await instrument();
        const broker = await account();
        const [source, target] = [await portfolio(), await portfolio()];
        await created({ type: "buy", accountId: broker, portfolioId: source, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(10), priceE6: price(100) });
        await setArchived(source, true);
        await setArchived(target, true);

        const details = await rejected(
          { type: "transfer", instrumentId: etf, tradeDate: "2026-02-01", quantityE8: units(2), from: { accountId: broker, portfolioId: source }, to: { accountId: broker, portfolioId: target } },
          "portfolio_archived",
        );
        assert.deepEqual(details, { portfolioId: target });
      });

      it("keeps a transfer whose outgoing leg is in an archived portfolio editable: its quantity and its date", async () => {
        const etf = await instrument();
        const broker = await account();
        const [source, target] = [await portfolio(), await portfolio()];
        await created({ type: "buy", accountId: broker, portfolioId: source, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(10), priceE6: price(100) });
        const legs = await created({
          type: "transfer",
          instrumentId: etf,
          tradeDate: "2026-02-01",
          quantityE8: units(2),
          from: { accountId: broker, portfolioId: source },
          to: { accountId: broker, portfolioId: target },
        });
        await setArchived(source, true);
        const outgoing = legs.find((leg) => leg.portfolioId === source)!;

        const quantity = await edited(outgoing.id, { quantityE8: units(3) });
        assert.deepEqual(quantity.map((leg) => leg.quantityE8).sort((a, b) => a - b), [-units(3), units(3)]);
        const date = await edited(outgoing.id, { tradeDate: "2026-02-15" });
        assert.deepEqual(date.map((leg) => [leg.portfolioId, leg.tradeDate]).sort(), [[source, "2026-02-15"], [target, "2026-02-15"]].sort());
      });

      it("records a split's row in an archived portfolio, so an archived holder never blocks the split", async () => {
        const etf = await instrument();
        const broker = await account();
        const [active, archived] = [await portfolio(), await portfolio()];
        const buy = { type: "buy", accountId: broker, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(10), priceE6: price(100) };
        await created({ ...buy, portfolioId: active });
        await created({ ...buy, portfolioId: archived });
        await setArchived(archived, true);

        const rows = await created({ type: "split", instrumentId: etf, tradeDate: "2026-03-01", splitFrom: 1, splitTo: 2 });
        assert.deepEqual(rows.map((row) => row.portfolioId).sort(), [active, archived].sort());
      });

      it("keeps the trades already in an archived portfolio editable and deletable, but refuses moving one into it", async () => {
        const etf = await instrument();
        const broker = await account();
        const [active, archived] = [await portfolio(), await portfolio()];
        const buy = { type: "buy", accountId: broker, instrumentId: etf, quantityE8: units(10), priceE6: price(100) };
        const [kept] = await created({ ...buy, portfolioId: archived, tradeDate: "2026-01-10" });
        const [dropped] = await created({ ...buy, portfolioId: archived, tradeDate: "2026-01-11" });
        const [elsewhere] = await created({ ...buy, portfolioId: active, tradeDate: "2026-01-12" });
        const legs = await created({
          type: "transfer",
          instrumentId: etf,
          tradeDate: "2026-01-20",
          quantityE8: units(2),
          from: { accountId: broker, portfolioId: active },
          to: { accountId: broker, portfolioId: archived },
        });
        const split = await created({ type: "split", instrumentId: etf, tradeDate: "2026-02-01", splitFrom: 1, splitTo: 2 });
        await setArchived(archived, true);

        const [rewritten] = await edited(kept!.id, { quantityE8: units(12), memo: "corrected" });
        assert.equal(rewritten!.portfolioId, archived);
        assert.equal(rewritten!.quantityE8, units(12));
        const incoming = legs.find((leg) => leg.portfolioId === archived)!;
        assert.equal((await edited(incoming.id, { quantityE8: units(3) })).length, 2);
        assert.equal((await edited(split[0]!.id, { splitTo: 3 })).length, 2);
        assert.equal((await remove(dropped!.id)).statusCode, 204);

        // Moving a trade, or a transfer's leg, into the archived portfolio is a new trade there.
        assert.equal((await refusedEdit(elsewhere!.id, { portfolioId: archived }, "portfolio_archived")).portfolioId, archived);
        const outgoing = legs.find((leg) => leg.portfolioId === active)!;
        const empty = await portfolio();
        await setArchived(empty, true);
        assert.equal((await refusedEdit(outgoing.id, { from: { portfolioId: empty } }, "portfolio_archived")).portfolioId, empty);
        // A trade can leave it.
        const [moved] = await edited(kept!.id, { portfolioId: active });
        assert.equal(moved!.portfolioId, active);
      });

      it("lets a split edit add a row for a holding in an archived portfolio", async () => {
        const etf = await instrument();
        const broker = await account();
        const [active, archived] = [await portfolio(), await portfolio()];
        const buy = { type: "buy", accountId: broker, instrumentId: etf, quantityE8: units(10), priceE6: price(100) };
        await created({ ...buy, portfolioId: active, tradeDate: "2026-01-10" });
        await created({ ...buy, portfolioId: archived, tradeDate: "2026-03-10" });
        const [split] = await created({ type: "split", instrumentId: etf, tradeDate: "2026-02-01", splitFrom: 1, splitTo: 2 });
        await setArchived(archived, true);

        // Moved after the archived portfolio's buy, the split gains a row there.
        const moved = await edited(split!.id, { tradeDate: "2026-04-01" });
        assert.deepEqual(moved.map((row) => row.portfolioId).sort(), [active, archived].sort());
      });
    });
  });
});
