import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { decodeJwt } from "jose";

import type { App } from "../app.ts";
import type { DbPool } from "../db/pool.ts";
import { setupIntegrationTest, teardownIntegrationTest, type IntegrationTestContext } from "../test-helpers/integration-setup.ts";

/** Units as quantityE8. */
const units = (value: number): number => Math.round(value * 1e8);
/** A price as priceE6 / closeE6. */
const price = (value: number): number => Math.round(value * 1e6);
const cents = (value: number): number => Math.round(value * 100);

type Role = "owner" | "editor" | "read_only";

interface MonthBody {
  readonly month: string;
  readonly valuationDate: string;
  readonly valueCents: number | null;
  readonly netContributionsCents: number | null;
  readonly incomeCents: number | null;
  readonly gainCents: number | null;
  readonly twrE6: number | null;
  readonly mwrE6: number | null;
  readonly oldestPriceDate: string | null;
  readonly oldestRateDate: string | null;
  readonly missing: { instrumentId: string | null; reason: string; currency?: string }[];
}

interface PerformanceBody {
  readonly baseCurrency: string;
  readonly from: string;
  readonly to: string;
  readonly months: MonthBody[];
  readonly totals: Record<string, unknown>;
}

/**
 * `GET .../portfolios/:portfolioId/performance` (#89). The test database is shared with other files
 * and outlives a run, and exchange rates are shared by every workspace, so this file's trades,
 * prices and rates are dated in 1903, which nothing else stores; its rates are removed afterwards.
 */
describe("performance route (#89)", () => {
  let ctx: IntegrationTestContext;
  let app: App;
  let superuserPool: DbPool;
  let workspaceA: string;
  let userA: string;
  let tokenA: string;
  let tokenB: string;
  let workspaceB: string;
  const namePrefix = `Performance${randomUUID().slice(0, 8)}`;

  before(async () => {
    ctx = await setupIntegrationTest({ workspaceName: "Performance A" });
    ({ app, superuserPool, token: tokenA, workspaceId: workspaceA } = ctx);
    const { rows: usersA } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      decodeJwt(tokenA).sub,
    ]);
    userA = usersA[0]!.id;

    tokenB = await ctx.realm.getTokenForNewUser();
    await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${tokenB}` } });
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [decodeJwt(tokenB).sub]);
    workspaceB = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Performance B', 'EUR', 'Europe/Rome')",
      [workspaceB],
    );
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [rows[0]!.id, workspaceB]);

    await superuserPool.query(
      `INSERT INTO fx_rates (base_currency, quote_currency, rate_date, rate_e10, source) VALUES
         ('EUR', 'USD', '1903-08-31', 11000000000, 'ecb'),
         ('EUR', 'USD', '1903-09-10', 12500000000, 'ecb'),
         ('EUR', 'USD', '1903-09-30', 12000000000, 'ecb'),
         ('EUR', 'USD', '1903-10-15', 12500000000, 'ecb'),
         ('EUR', 'USD', '1903-10-30', 11000000000, 'ecb')
       ON CONFLICT DO NOTHING`,
    );
  });

  after(async () => {
    await superuserPool.query("DELETE FROM fx_rates WHERE rate_date BETWEEN '1903-01-01' AND '1903-12-31'");
    await superuserPool.query("DELETE FROM prices WHERE instrument_id IN (SELECT id FROM instruments WHERE name LIKE $1)", [`${namePrefix}%`]);
    // The trades go with their workspaces; only then can the instruments they referenced go.
    await superuserPool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[workspaceA, workspaceB]]);
    await superuserPool.query("DELETE FROM instruments WHERE name LIKE $1 AND workspace_id IS NULL", [`${namePrefix}%`]);
    await teardownIntegrationTest(ctx);
  });

  beforeEach(async () => {
    await setRole("owner");
  });

  async function setRole(role: Role): Promise<void> {
    await superuserPool.query("UPDATE memberships SET role = $1 WHERE user_id = $2 AND workspace_id = $3", [role, userA, workspaceA]);
  }

  async function instrument(currency: string): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO instruments (ticker, exchange, name, type, currency) VALUES ($1, 'XMIL', $2, 'fund', $3) RETURNING id",
      [`F${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`, `${namePrefix} ${randomUUID()}`, currency],
    );
    return rows[0]!.id;
  }

  async function account(currency: string, workspaceId = workspaceA): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      `INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, $2, 'brokerage', $3, false) RETURNING id`,
      [workspaceId, `Broker ${randomUUID().slice(0, 8)}`, currency],
    );
    return rows[0]!.id;
  }

  async function portfolio(workspaceId = workspaceA): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>("INSERT INTO portfolios (workspace_id, name) VALUES ($1, $2) RETURNING id", [
      workspaceId,
      `Portfolio ${randomUUID()}`,
    ]);
    return rows[0]!.id;
  }

  async function sharedPrice(instrumentId: string, date: string, close: number): Promise<void> {
    await superuserPool.query(
      "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source, provider) VALUES (NULL, $1, $2, $3, 'provider', 'test')",
      [instrumentId, date, price(close)],
    );
  }

  async function ownPrice(instrumentId: string, date: string, close: number): Promise<void> {
    const response = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceA}/instruments/${instrumentId}/prices/${date}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { closeE6: price(close) },
    });
    assert.equal(response.statusCode, 201, response.body);
  }

  async function trade(payload: Record<string, unknown>): Promise<void> {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceA}/trades`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload,
    });
    assert.equal(response.statusCode, 201, response.body);
  }

  function get(path: string, token = tokenA, workspaceId = workspaceA) {
    return app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}${path}`, headers: { authorization: `Bearer ${token}` } });
  }

  async function performance(portfolioId: string, from: string, to: string): Promise<PerformanceBody> {
    const response = await get(`/portfolios/${portfolioId}/performance?from=${from}&to=${to}`);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }

  /** The core's reference example (performance.test.ts), in 1903: a euro ETF and a dollar stock in one portfolio. */
  async function referencePortfolio(): Promise<{ portfolioId: string; etf: string; stock: string }> {
    const etf = await instrument("EUR");
    const stock = await instrument("USD");
    const eurBroker = await account("EUR");
    const usdBroker = await account("USD");
    const portfolioId = await portfolio();
    await trade({ type: "buy", accountId: eurBroker, portfolioId, instrumentId: etf, tradeDate: "1903-08-03", quantityE8: units(100), priceE6: price(100) });
    await trade({
      type: "buy",
      accountId: usdBroker,
      portfolioId,
      instrumentId: stock,
      tradeDate: "1903-09-10",
      quantityE8: units(10),
      priceE6: price(200),
      feesCents: 500,
    });
    await trade({
      type: "dividend",
      accountId: usdBroker,
      portfolioId,
      instrumentId: stock,
      tradeDate: "1903-10-15",
      grossCents: 2500,
      withholdingForeignCents: 500,
    });
    for (const [date, close] of [
      ["1903-08-03", 100],
      ["1903-09-10", 105],
      ["1903-09-30", 106],
      ["1903-10-31", 104],
    ] as const) {
      await sharedPrice(etf, date, close);
    }
    for (const [date, close] of [
      ["1903-09-10", 200],
      ["1903-09-30", 210],
      ["1903-10-30", 220],
    ] as const) {
      await sharedPrice(stock, date, close);
    }
    return { portfolioId, etf, stock };
  }

  it("needs a token", async () => {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceA}/portfolios/${randomUUID()}/performance?from=1903-09&to=1903-10`,
    });
    assert.equal(response.statusCode, 401);
  });

  it("computes the reference example across two currencies, each flow and value at its own date's rate", async () => {
    const { portfolioId } = await referencePortfolio();
    const body = await performance(portfolioId, "1903-09", "1903-10");
    assert.equal(body.baseCurrency, "EUR");
    assert.deepEqual(
      body.months.map((row) => [row.month, row.valuationDate, row.valueCents, row.netContributionsCents, row.incomeCents, row.gainCents]),
      [
        ["1903-09", "1903-09-30", cents(12_350), cents(1_604), 0, cents(746)],
        ["1903-10", "1903-10-31", cents(12_400), 0, cents(16), cents(66)],
      ],
    );
    assert.deepEqual(
      body.months.map((row) => [row.twrE6, row.mwrE6, row.oldestPriceDate, row.oldestRateDate, row.missing]),
      [
        [71_286, 67_465, "1903-09-30", "1903-09-30", []],
        [5_357, 5_348, "1903-10-30", "1903-10-30", []],
      ],
    );
    assert.deepEqual(body.totals, {
      startDate: "1903-08-31",
      endDate: "1903-10-31",
      startValueCents: cents(10_000),
      endValueCents: cents(12_400),
      netContributionsCents: cents(1_604),
      incomeCents: cents(16),
      gainCents: cents(812),
      twrE6: 77_025,
      twrAnnualized: false,
      mwrE6: 71_673,
      mwrAnnualized: false,
      missing: [],
    });
  });

  it("gives an unpriced instrument's month a null value and a missing entry, never a partial sum", async () => {
    const priced = await instrument("EUR");
    const unpriced = await instrument("EUR");
    const broker = await account("EUR");
    const portfolioId = await portfolio();
    await trade({ type: "buy", accountId: broker, portfolioId, instrumentId: priced, tradeDate: "1903-03-02", quantityE8: units(10), priceE6: price(10) });
    await trade({ type: "buy", accountId: broker, portfolioId, instrumentId: unpriced, tradeDate: "1903-03-05", quantityE8: units(1), priceE6: price(50) });
    await sharedPrice(priced, "1903-03-02", 10);

    const [row] = (await performance(portfolioId, "1903-03", "1903-03")).months;
    assert.equal(row?.valueCents, null);
    assert.equal(row?.gainCents, null);
    assert.equal(row?.twrE6, null);
    assert.deepEqual(row?.missing, [{ instrumentId: unpriced, reason: "no_price" }]);
  });

  it("names the currency of a value with no rate", async () => {
    const yen = await instrument("JPY");
    const broker = await account("JPY");
    const portfolioId = await portfolio();
    await trade({ type: "buy", accountId: broker, portfolioId, instrumentId: yen, tradeDate: "1903-04-01", quantityE8: units(1), priceE6: price(1000) });
    await sharedPrice(yen, "1903-04-01", 1000);

    const [row] = (await performance(portfolioId, "1903-04", "1903-04")).months;
    assert.equal(row?.valueCents, null);
    assert.equal(row?.netContributionsCents, null);
    assert.deepEqual(row?.missing, [{ instrumentId: yen, reason: "no_rate", currency: "JPY" }]);
  });

  it("values with the workspace's own price over a shared one of the same date", async () => {
    const etf = await instrument("EUR");
    const broker = await account("EUR");
    const portfolioId = await portfolio();
    await trade({ type: "buy", accountId: broker, portfolioId, instrumentId: etf, tradeDate: "1903-05-04", quantityE8: units(10), priceE6: price(100) });
    await sharedPrice(etf, "1903-05-04", 100);
    await sharedPrice(etf, "1903-05-29", 120);
    await ownPrice(etf, "1903-05-29", 110);

    const [row] = (await performance(portfolioId, "1903-05", "1903-05")).months;
    assert.equal(row?.valueCents, cents(1_100));
    assert.equal(row?.oldestPriceDate, "1903-05-29");
    assert.equal(row?.twrE6, 100_000);
  });

  it("lets every role read", async () => {
    const etf = await instrument("EUR");
    const broker = await account("EUR");
    const portfolioId = await portfolio();
    await trade({ type: "buy", accountId: broker, portfolioId, instrumentId: etf, tradeDate: "1903-06-01", quantityE8: units(1), priceE6: price(100) });
    for (const role of ["owner", "editor", "read_only"] as const) {
      await setRole(role);
      const response = await get(`/portfolios/${portfolioId}/performance?from=1903-06&to=1903-06`);
      assert.equal(response.statusCode, 200, `${role}: ${response.body}`);
    }
  });

  it("answers another workspace's, an unknown and a malformed portfolio id with the same 404", async () => {
    const portfolioOfB = await portfolio(workspaceB);
    const query = "/performance?from=1903-06&to=1903-06";
    for (const id of [portfolioOfB, randomUUID(), "not-a-uuid"]) {
      const response = await get(`/portfolios/${id}${query}`);
      assert.equal(response.statusCode, 404, id);
      assert.deepEqual(response.json(), { error: "portfolio not found" }, id);
    }
    // Workspace B's member cannot reach A's portfolio through B, nor through A.
    const portfolioId = await portfolio();
    const throughB = await get(`/portfolios/${portfolioId}${query}`, tokenB, workspaceB);
    assert.equal(throughB.statusCode, 404);
    assert.deepEqual(throughB.json(), { error: "portfolio not found" });
    const throughA = await get(`/portfolios/${portfolioId}${query}`, tokenB, workspaceA);
    assert.equal(throughA.statusCode, 403);
  });

  it("refuses a missing, malformed, reversed, future or too long range", async () => {
    const portfolioId = await portfolio();
    const { rows } = await superuserPool.query<{ month: string; next: string }>(
      `SELECT to_char(now() AT TIME ZONE time_zone, 'YYYY-MM') AS month,
              to_char(date_trunc('month', now() AT TIME ZONE time_zone) + interval '1 month', 'YYYY-MM') AS next
       FROM workspaces WHERE id = $1`,
      [workspaceA],
    );
    const { month, next } = rows[0]!;
    const cases: [string, Record<string, unknown>][] = [
      ["to=1903-06", { error: "invalid_month", details: { field: "from", value: null } }],
      ["from=1903-6&to=1903-06", { error: "invalid_month", details: { field: "from", value: "1903-6" } }],
      ["from=1903-06&to=1903-13", { error: "invalid_month", details: { field: "to", value: "1903-13" } }],
      ["from=1903-06&to=1903-05", { error: "invalid_month", details: { field: "to", value: "1903-05" } }],
      [`from=1903-06&to=${next}`, { error: "invalid_month", details: { field: "to", value: next, max: month } }],
      ["from=1903-01&to=1913-01", { error: "range_too_long", details: { months: 121, max: 120 } }],
    ];
    for (const [query, expected] of cases) {
      const response = await get(`/portfolios/${portfolioId}/performance?${query}`);
      assert.equal(response.statusCode, 400, query);
      assert.deepEqual(response.json(), expected, query);
    }
    const longest = await get(`/portfolios/${portfolioId}/performance?from=1903-01&to=1912-12`);
    assert.equal(longest.statusCode, 200, longest.body);
    assert.equal((longest.json() as PerformanceBody).months.length, 120);
  });

  it("values the current month at today in the workspace's time zone", async () => {
    const portfolioId = await portfolio();
    const today = async (): Promise<string> => {
      const { rows } = await superuserPool.query<{ today: string }>(
        "SELECT to_char(now() AT TIME ZONE time_zone, 'YYYY-MM-DD') AS today FROM workspaces WHERE id = $1",
        [workspaceA],
      );
      return rows[0]!.today;
    };
    const first = await today();
    const body = await performance(portfolioId, first.slice(0, 7), first.slice(0, 7));
    const afterwards = await today();
    // The endpoint reads "today" itself: it falls between the two readings around the request.
    const valuationDate = body.months[0]!.valuationDate;
    assert.ok(first <= valuationDate && valuationDate <= afterwards, `${first} <= ${valuationDate} <= ${afterwards}`);
    assert.equal(body.months[0]?.valueCents, 0);
  });
});
