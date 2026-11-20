import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { decodeJwt } from "jose";

import { type App } from "../app.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString } from "../test-helpers/app-role.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";
import { loadPositionTrades } from "../trades/repository.ts";

/** Units as quantityE8: units(1.5) is 150000000. */
const units = (value: number): number => Math.round(value * 1e8);
/** A price as priceE6. */
const price = (value: number): number => Math.round(value * 1e6);

interface PositionBody {
  readonly accountId: string;
  readonly instrument: Record<string, unknown> & { readonly id: string };
  readonly currency: string;
  readonly quantityE8: number;
  readonly costBasisCents: number;
  readonly accountAverageCostE6: number | null;
  readonly realizedCents: number;
  readonly costInCents: number;
  readonly costSoldCents: number;
  readonly costTransferredOutCents: number;
  readonly tradeFeesCents: number;
  readonly incomeFeesCents: number;
  readonly transferFeesCents: number;
  readonly transactionTaxCents: number;
  readonly accruedInterestPaidCents: number;
  readonly accruedInterestReceivedCents: number;
  readonly gainTaxWithheldCents: number;
  readonly gainTaxAdjustmentsCents: number;
  readonly managedResultTaxCents: number;
  readonly incomeGrossCents: number;
  readonly withholdingForeignCents: number;
  readonly withholdingDomesticCents: number;
  readonly standaloneFeesCents: number;
  readonly standaloneTaxesCents: number;
  readonly incomeCents: number;
  readonly costsCents: number;
  readonly taxesOnGainsCents: number;
}

type SummaryBody = Omit<PositionBody, "accountId" | "instrument" | "quantityE8" | "accountAverageCostE6">;

interface PositionsBody {
  readonly positions: PositionBody[];
  readonly summaries: SummaryBody[];
}

/** Every total at zero: a test spreads it and states only the totals it expects to be set. */
const NO_TOTALS = {
  realizedCents: 0,
  costInCents: 0,
  costSoldCents: 0,
  costTransferredOutCents: 0,
  tradeFeesCents: 0,
  incomeFeesCents: 0,
  transferFeesCents: 0,
  transactionTaxCents: 0,
  accruedInterestPaidCents: 0,
  accruedInterestReceivedCents: 0,
  gainTaxWithheldCents: 0,
  gainTaxAdjustmentsCents: 0,
  managedResultTaxCents: 0,
  incomeGrossCents: 0,
  withholdingForeignCents: 0,
  withholdingDomesticCents: 0,
  standaloneFeesCents: 0,
  standaloneTaxesCents: 0,
  incomeCents: 0,
  costsCents: 0,
  taxesOnGainsCents: 0,
};

describe("positions routes (#79)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  let userId: string;
  const otherWorkspaceIds: string[] = [];
  const instrumentIds: string[] = [];

  function headers(): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  async function trade(payload: Record<string, unknown>, ws = workspaceId): Promise<void> {
    const response = await app.fastify.inject({ method: "POST", url: `/workspaces/${ws}/trades`, headers: headers(), payload });
    assert.equal(response.statusCode, 201, response.body);
  }

  async function get(path: string, ws = workspaceId) {
    return app.fastify.inject({ method: "GET", url: `/workspaces/${ws}${path}`, headers: headers() });
  }

  async function positionsOf(kind: "portfolios" | "accounts", id: string): Promise<PositionsBody> {
    const response = await get(`/${kind}/${id}/positions`);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }

  async function instrument(currency = "EUR", type = "fund", priceFactorE6 = 1_000_000): Promise<string> {
    const ticker = `T${randomBytes(6).toString("hex").toUpperCase()}`;
    const { rows } = await superuserPool.query<{ id: string }>(
      `INSERT INTO instruments (isin, ticker, exchange, name, type, currency, price_factor_e6)
       VALUES (NULL, $1, 'XMIL', 'Test fund', $2, $3, $4) RETURNING id`,
      [ticker, type, currency, priceFactorE6],
    );
    instrumentIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function account(type = "brokerage", ws = workspaceId, currency = "EUR"): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      `INSERT INTO accounts (workspace_id, name, type, currency, on_budget)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ws, `Account ${randomUUID().slice(0, 8)}`, type, currency, type !== "brokerage"],
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

  async function addWorkspace(role: "owner" | "editor" | "read_only"): Promise<string> {
    const id = randomUUID();
    otherWorkspaceIds.push(id);
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Other', 'EUR', 'Europe/Rome')",
      [id],
    );
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [userId, id, role]);
    return id;
  }

  async function setRole(role: "owner" | "editor" | "read_only"): Promise<void> {
    await superuserPool.query("UPDATE memberships SET role = $1 WHERE user_id = $2 AND workspace_id = $3", [role, userId, workspaceId]);
  }

  /**
   * The domain guide's "Two portfolios, one average": A buys 10 at €100 with a €5 fee, B (same
   * account) 30 at €120 with a €5 fee, A sells 5 at €130 with a €5 fee.
   */
  async function twoPortfolios() {
    const etf = await instrument();
    const broker = await account();
    const a = await portfolio();
    const b = await portfolio();
    const common = { accountId: broker, instrumentId: etf };
    await trade({ ...common, type: "buy", portfolioId: a, tradeDate: "2026-01-05", quantityE8: units(10), priceE6: price(100), feesCents: 500 });
    await trade({ ...common, type: "buy", portfolioId: b, tradeDate: "2026-01-06", quantityE8: units(30), priceE6: price(120), feesCents: 500 });
    await trade({ ...common, type: "sell", portfolioId: a, tradeDate: "2026-01-07", quantityE8: units(5), priceE6: price(130), feesCents: 500 });
    return { etf, broker, a, b };
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

  it("rejects a request with no token, on both routes", async () => {
    for (const kind of ["portfolios", "accounts"]) {
      const response = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/${kind}/${randomUUID()}/positions` });
      assert.equal(response.statusCode, 401, kind);
    }
  });

  it("splits one account's average between two portfolios and gives the gain to the seller", async () => {
    const { etf, broker, a, b } = await twoPortfolios();

    const ofA = await positionsOf("portfolios", a);
    assert.deepEqual(ofA.positions, [
      {
        ...NO_TOTALS,
        accountId: broker,
        instrument: {
          id: etf,
          isin: null,
          ticker: ofA.positions[0]!.instrument.ticker,
          exchange: "XMIL",
          name: "Test fund",
          type: "fund",
          currency: "EUR",
          assetClass: null,
          priceFactorE6: 1_000_000,
        },
        currency: "EUR",
        quantityE8: units(5),
        costBasisCents: 57_625, // A's share of €4,033.75: 5 of 35 units
        accountAverageCostE6: price(115.25), // the account's average, shared by both portfolios
        realizedCents: 6_875, // 650 − 5 − 576.25
        costInCents: 100_500,
        costSoldCents: 57_625,
        tradeFeesCents: 1_000,
      },
    ]);
    assert.match(String(ofA.positions[0]!.instrument.ticker), /^T[0-9A-F]{12}$/);
    assert.deepEqual(ofA.summaries, [
      { ...NO_TOTALS, currency: "EUR", costBasisCents: 57_625, realizedCents: 6_875, costInCents: 100_500, costSoldCents: 57_625, tradeFeesCents: 1_000 },
    ]);

    const ofB = await positionsOf("portfolios", b);
    assert.equal(ofB.positions.length, 1);
    assert.equal(ofB.positions[0]!.quantityE8, units(30));
    assert.equal(ofB.positions[0]!.costBasisCents, 345_750);
    assert.equal(ofB.positions[0]!.accountAverageCostE6, price(115.25));
    assert.equal(ofB.positions[0]!.realizedCents, 0);

    const ofAccount = await positionsOf("accounts", broker);
    assert.equal(ofAccount.positions.length, 1);
    assert.deepEqual(
      { ...ofAccount.positions[0]!, instrument: ofAccount.positions[0]!.instrument.id },
      {
        ...NO_TOTALS,
        accountId: broker,
        instrument: etf,
        currency: "EUR",
        quantityE8: units(35),
        costBasisCents: 403_375,
        accountAverageCostE6: price(115.25),
        realizedCents: 6_875,
        costInCents: 461_000,
        costSoldCents: 57_625,
        tradeFeesCents: 1_500,
      },
    );
    assert.equal(ofAccount.summaries.length, 1);
    assert.equal(ofAccount.summaries[0]!.costBasisCents, 403_375);
  });

  it("applies a split 1:4 to every portfolio, keeping the cost", async () => {
    const { etf, broker, a, b } = await twoPortfolios();
    await trade({ type: "split", instrumentId: etf, tradeDate: "2026-02-02", splitFrom: 1, splitTo: 4 });

    const [ofA] = (await positionsOf("portfolios", a)).positions;
    const [ofB] = (await positionsOf("portfolios", b)).positions;
    const [ofAccount] = (await positionsOf("accounts", broker)).positions;
    assert.deepEqual(
      [ofA, ofB, ofAccount].map((row) => [row!.quantityE8, row!.costBasisCents, row!.accountAverageCostE6, row!.realizedCents]),
      [
        [units(20), 57_625, price(28.8125), 6_875],
        [units(120), 345_750, price(28.8125), 0],
        [units(140), 403_375, price(28.8125), 6_875],
      ],
    );
  });

  it("carries a transfer's cost from the source account, replaying another portfolio's trades", async () => {
    const etf = await instrument();
    const source = await account();
    const target = await account();
    const growth = await portfolio();
    const moved = await portfolio();
    await trade({ type: "buy", accountId: source, portfolioId: growth, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(10), priceE6: price(100) });
    await trade({
      type: "transfer",
      instrumentId: etf,
      tradeDate: "2026-03-01",
      quantityE8: units(5),
      from: { accountId: source, portfolioId: growth, feesCents: 2_500 },
      to: { accountId: target, portfolioId: moved },
    });

    const before = await positionsOf("portfolios", moved);
    assert.equal(before.positions.length, 1);
    assert.equal(before.positions[0]!.accountId, target);
    assert.equal(before.positions[0]!.costBasisCents, 50_000);

    // Backdated before the transfer, in the source account and another portfolio: the 5 units left
    // an account holding 20 for €2,300, so they carried €575.
    await trade({ type: "buy", accountId: source, portfolioId: growth, instrumentId: etf, tradeDate: "2026-02-01", quantityE8: units(10), priceE6: price(130) });

    const ofMoved = await positionsOf("portfolios", moved);
    assert.deepEqual(
      ofMoved.positions.map((row) => ({ ...row, instrument: row.instrument.id })),
      [
        {
          ...NO_TOTALS,
          accountId: target,
          instrument: etf,
          currency: "EUR",
          quantityE8: units(5),
          costBasisCents: 57_500,
          accountAverageCostE6: price(115),
          costInCents: 57_500,
        },
      ],
    );

    const ofGrowth = await positionsOf("portfolios", growth);
    assert.deepEqual(
      ofGrowth.positions.map((row) => [row.accountId, row.quantityE8, row.costBasisCents, row.costTransferredOutCents, row.transferFeesCents]),
      [[source, units(15), 172_500, 57_500, 2_500]],
    );
    // A transfer's fee is part of neither cost.
    assert.equal(ofGrowth.summaries[0]!.transferFeesCents, 2_500);

    const ofTarget = await positionsOf("accounts", target);
    assert.deepEqual(
      ofTarget.positions.map((row) => [row.quantityE8, row.costBasisCents, row.accountAverageCostE6]),
      [[units(5), 57_500, price(115)]],
    );
  });

  it("keeps the financial transaction tax and the gain tax out of the cost and the gain", async () => {
    const shares = await instrument();
    const broker = await account();
    const plan = await portfolio();
    const common = { accountId: broker, portfolioId: plan, instrumentId: shares };
    await trade({ ...common, type: "buy", tradeDate: "2026-04-01", quantityE8: units(100), priceE6: price(50), feesCents: 500, transactionTaxCents: 500 });
    await trade({ ...common, type: "buy", tradeDate: "2026-04-02", quantityE8: units(50), priceE6: price(62), feesCents: 500 });
    await trade({ ...common, type: "sell", tradeDate: "2026-04-03", quantityE8: units(60), priceE6: price(70), feesCents: 500, gainTaxCents: 24_726 });
    await trade({ ...common, type: "tax", tradeDate: "2026-04-10", taxKind: "gain_tax_adjustment", grossCents: 10_000 });
    // A custody fee charged on the whole account: in the portfolio's summary, in no position.
    await trade({ type: "fee", accountId: broker, portfolioId: plan, instrumentId: null, tradeDate: "2026-04-30", feesCents: 300 });

    const { positions, summaries } = await positionsOf("portfolios", plan);
    assert.deepEqual(
      positions.map((row) => ({ ...row, instrument: row.instrument.id })),
      [
        {
          ...NO_TOTALS,
          accountId: broker,
          instrument: shares,
          currency: "EUR",
          quantityE8: units(90),
          costBasisCents: 486_600, // 8,110 − 3,244
          accountAverageCostE6: 54_066_667, // 4,866 ÷ 90, half to even at 6 decimals
          realizedCents: 95_100, // 4,200 − 5 − 3,244
          costInCents: 811_000,
          costSoldCents: 324_400,
          tradeFeesCents: 1_500,
          transactionTaxCents: 500,
          gainTaxWithheldCents: 24_726,
          gainTaxAdjustmentsCents: 10_000, // a refund, positive as entered
          costsCents: 500, // the transaction tax
          taxesOnGainsCents: 14_726, // 247.26 withheld − 100 refunded
        },
      ],
    );
    assert.deepEqual(summaries, [
      {
        ...NO_TOTALS,
        currency: "EUR",
        costBasisCents: 486_600,
        realizedCents: 95_100,
        costInCents: 811_000,
        costSoldCents: 324_400,
        tradeFeesCents: 1_500,
        transactionTaxCents: 500,
        gainTaxWithheldCents: 24_726,
        gainTaxAdjustmentsCents: 10_000,
        standaloneFeesCents: 300,
        costsCents: 800, // the transaction tax and the custody fee
        taxesOnGainsCents: 14_726,
      },
    ]);

    const ofAccount = await positionsOf("accounts", broker);
    assert.equal(ofAccount.summaries[0]!.standaloneFeesCents, 300);
    assert.equal(ofAccount.positions[0]!.standaloneFeesCents, 0);
  });

  it("returns a dividend's income as its own totals", async () => {
    const fund = await instrument();
    const broker = await account();
    const income = await portfolio();
    const common = { accountId: broker, portfolioId: income, instrumentId: fund };
    await trade({ ...common, type: "buy", tradeDate: "2026-05-04", quantityE8: units(10), priceE6: price(40), feesCents: 500 });
    await trade({
      ...common,
      type: "dividend",
      tradeDate: "2026-06-15",
      grossCents: 2_000,
      withholdingForeignCents: 300,
      withholdingDomesticCents: 442,
      feesCents: 200,
    });

    const { positions, summaries } = await positionsOf("portfolios", income);
    const [position] = positions;
    assert.equal(position!.incomeGrossCents, 2_000);
    assert.equal(position!.withholdingForeignCents, 300);
    assert.equal(position!.withholdingDomesticCents, 442);
    assert.equal(position!.incomeFeesCents, 200);
    assert.equal(position!.costBasisCents, 40_500, "a dividend leaves the cost unchanged");
    // €10.58: the €5 fee paid on the buy is not subtracted again.
    assert.equal(position!.incomeCents, 1_058);
    assert.equal(summaries[0]!.incomeCents, 1_058);
  });

  it("keeps a position sold out, for its totals, with no average cost", async () => {
    const etf = await instrument();
    const broker = await account();
    const trading = await portfolio();
    const common = { accountId: broker, portfolioId: trading, instrumentId: etf };
    await trade({ ...common, type: "buy", tradeDate: "2026-01-05", quantityE8: units(2), priceE6: price(10) });
    await trade({ ...common, type: "sell", tradeDate: "2026-01-06", quantityE8: units(2), priceE6: price(12) });

    const [position] = (await positionsOf("portfolios", trading)).positions;
    assert.deepEqual([position!.quantityE8, position!.costBasisCents, position!.accountAverageCostE6, position!.realizedCents], [0, 0, null, 400]);
  });

  it("returns no positions for a portfolio without trades and for an account that is not a brokerage account", async () => {
    assert.deepEqual(await positionsOf("portfolios", await portfolio()), { positions: [], summaries: [] });
    assert.deepEqual(await positionsOf("accounts", await account("checking")), { positions: [], summaries: [] });
    assert.deepEqual(await positionsOf("accounts", await account()), { positions: [], summaries: [] });
  });

  it("reads an archived portfolio's positions", async () => {
    const { a } = await twoPortfolios();
    await superuserPool.query("UPDATE portfolios SET archived_at = now() WHERE id = $1", [a]);
    const { positions } = await positionsOf("portfolios", a);
    assert.equal(positions[0]!.quantityE8, units(5));
  });

  it("accepts an upper-case account id", async () => {
    const { broker } = await twoPortfolios();
    const { positions } = await positionsOf("accounts", broker.toUpperCase());
    assert.equal(positions[0]!.quantityE8, units(35));
  });

  it("answers 404 for another workspace's, an unknown or a malformed portfolio or account", async () => {
    const other = await addWorkspace("owner");
    const theirPortfolio = await portfolio(other);
    const theirAccount = await account("brokerage", other);
    for (const path of [
      `/portfolios/${theirPortfolio}/positions`,
      `/portfolios/${randomUUID()}/positions`,
      "/portfolios/not-a-uuid/positions",
      `/accounts/${theirAccount}/positions`,
      `/accounts/${randomUUID()}/positions`,
      "/accounts/not-a-uuid/positions",
    ]) {
      const response = await get(path);
      assert.equal(response.statusCode, 404, `${path}: ${response.body}`);
    }
    // Through its own workspace, the same portfolio is readable.
    assert.equal((await get(`/portfolios/${theirPortfolio}/positions`, other)).statusCode, 200);
  });

  it("loads only the session workspace's trades of a catalog instrument another workspace also trades", async () => {
    const { etf, a } = await twoPortfolios();
    const other = await addWorkspace("owner");
    const theirAccount = await account("brokerage", other);
    const theirPortfolio = await portfolio(other);
    await trade(
      { type: "buy", accountId: theirAccount, portfolioId: theirPortfolio, instrumentId: etf, tradeDate: "2026-01-06", quantityE8: units(1), priceE6: price(500) },
      other,
    );
    const ids = async (ws: string): Promise<string[]> => {
      const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM trades WHERE workspace_id = $1 AND instrument_id = $2", [ws, etf]);
      return rows.map((row) => row.id).sort();
    };
    const ours = await ids(workspaceId);
    const [theirs] = await ids(other);
    assert.equal(ours.length, 3);
    assert.ok(theirs);

    // As the request runs it: envelope_app, Row-Level Security on, the session in workspace A.
    const appPool = createPool(appConnectionString(process.env.DATABASE_URL!));
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      const loaded = await loadPositionTrades(client, workspaceId, { portfolioId: a });
      assert.deepEqual(loaded.map((row) => row.id).sort(), ours);
      assert.ok(!loaded.some((row) => row.id === theirs));
      // B's workspace id while the session is A's: Row-Level Security returns nothing.
      assert.deepEqual(await loadPositionTrades(client, other, { portfolioId: theirPortfolio }), []);
      assert.deepEqual(await loadPositionTrades(client, other, { accountId: theirAccount }), []);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await appPool.end();
    }
  });

  it("gives a bond's average cost in percent of nominal, its price unit", async () => {
    const bond = await instrument("EUR", "government_bond", 10_000);
    const broker = await account();
    const savings = await portfolio();
    await trade({ type: "buy", accountId: broker, portfolioId: savings, instrumentId: bond, tradeDate: "2026-03-02", quantityE8: units(10_000), priceE6: price(98.765432) });

    const [position] = (await positionsOf("portfolios", savings)).positions;
    assert.equal(position!.instrument.priceFactorE6, 10_000);
    assert.equal(position!.costBasisCents, 987_654); // 10,000 × 98.765432 × 0.01 = €9,876.5432
    assert.equal(position!.accountAverageCostE6, 98_765_400); // 9,876.54 ÷ (10,000 × 0.01): 98.7654
  });

  it("realizes a reverse split's cash in lieu at the account's average", async () => {
    const { etf, broker, a, b } = await twoPortfolios();
    await trade({ type: "split", instrumentId: etf, tradeDate: "2026-02-02", splitFrom: 10, splitTo: 1 });
    // A's 0.5 units sold for €650 (€1,300 per unit), no fee.
    await trade({ type: "sell", accountId: broker, portfolioId: a, instrumentId: etf, tradeDate: "2026-02-03", quantityE8: units(0.5), priceE6: price(1300) });

    const [ofA] = (await positionsOf("portfolios", a)).positions;
    assert.deepEqual(
      [ofA!.quantityE8, ofA!.costBasisCents, ofA!.accountAverageCostE6, ofA!.costSoldCents, ofA!.realizedCents],
      [0, 0, null, 57_625 + 57_625, 6_875 + 7_375], // 650 − 4,033.75 × 0.5 ÷ 3.5 = 73.75
    );
    const [ofB] = (await positionsOf("portfolios", b)).positions;
    assert.deepEqual([ofB!.quantityE8, ofB!.costBasisCents], [units(3), 345_750]);
  });

  it("averages in a transfer from outside the app with the cost it carries", async () => {
    const etf = await instrument();
    const broker = await account();
    const plan = await portfolio();
    await trade({ type: "buy", accountId: broker, portfolioId: plan, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(10), priceE6: price(120) });
    await trade({
      type: "transfer",
      instrumentId: etf,
      tradeDate: "2026-02-10",
      quantityE8: units(10),
      to: { accountId: broker, portfolioId: plan, costBasisCents: 100_000 },
    });
    const [position] = (await positionsOf("portfolios", plan)).positions;
    assert.deepEqual(
      [position!.quantityE8, position!.costBasisCents, position!.accountAverageCostE6, position!.realizedCents],
      [units(20), 220_000, price(110), 0],
    );
  });

  it("leaves out another portfolio's and another account's fees recorded without an instrument", async () => {
    const etf = await instrument();
    const first = await account();
    const second = await account();
    const mine = await portfolio();
    const theirs = await portfolio();
    await trade({ type: "buy", accountId: first, portfolioId: mine, instrumentId: etf, tradeDate: "2026-01-10", quantityE8: units(1), priceE6: price(100) });
    await trade({ type: "fee", accountId: first, portfolioId: theirs, instrumentId: null, tradeDate: "2026-01-31", feesCents: 300 });
    await trade({ type: "fee", accountId: second, portfolioId: mine, instrumentId: null, tradeDate: "2026-01-31", feesCents: 100 });

    const ofMine = await positionsOf("portfolios", mine);
    assert.deepEqual(ofMine.summaries.map((row) => [row.standaloneFeesCents, row.costsCents]), [[100, 100]]);
    assert.equal(ofMine.positions[0]!.standaloneFeesCents, 0);
    const ofTheirs = await positionsOf("portfolios", theirs);
    assert.deepEqual([ofTheirs.positions, ofTheirs.summaries.map((row) => row.standaloneFeesCents)], [[], [300]]);
    assert.deepEqual((await positionsOf("accounts", first)).summaries.map((row) => row.standaloneFeesCents), [300]);
    assert.deepEqual((await positionsOf("accounts", second)).summaries.map((row) => row.standaloneFeesCents), [100]);
  });

  it("gives a portfolio spanning two currencies one summary per currency, sorted", async () => {
    const inEuro = await instrument("EUR");
    const inDollars = await instrument("USD");
    const euroBroker = await account("brokerage", workspaceId, "EUR");
    const dollarBroker = await account("brokerage", workspaceId, "USD");
    const global = await portfolio();
    await trade({ type: "buy", accountId: dollarBroker, portfolioId: global, instrumentId: inDollars, tradeDate: "2026-01-10", quantityE8: units(2), priceE6: price(50), feesCents: 100 });
    await trade({ type: "buy", accountId: euroBroker, portfolioId: global, instrumentId: inEuro, tradeDate: "2026-01-11", quantityE8: units(3), priceE6: price(10) });

    const { positions, summaries } = await positionsOf("portfolios", global);
    assert.deepEqual(positions.map((row) => row.currency).sort(), ["EUR", "USD"]);
    assert.deepEqual(
      summaries.map((row) => [row.currency, row.costBasisCents, row.tradeFeesCents]),
      [
        ["EUR", 3_000, 0],
        ["USD", 10_100, 100],
      ],
    );
  });

  it("refuses a workspace the user is not a member of, on both routes", async () => {
    const stranger = randomUUID();
    otherWorkspaceIds.push(stranger);
    await superuserPool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Stranger', 'EUR', 'Europe/Rome')", [stranger]);
    const theirPortfolio = await portfolio(stranger);
    const theirAccount = await account("brokerage", stranger);
    for (const path of [`/portfolios/${theirPortfolio}/positions`, `/accounts/${theirAccount}/positions`]) {
      const response = await get(path, stranger);
      assert.equal(response.statusCode, 403, `${path}: ${response.body}`);
    }
  });

  it("lets a read_only member read positions", async () => {
    const { a, broker } = await twoPortfolios();
    await setRole("read_only");
    try {
      assert.equal((await positionsOf("portfolios", a)).positions[0]!.realizedCents, 6_875);
      assert.equal((await positionsOf("accounts", broker)).positions[0]!.costBasisCents, 403_375);
    } finally {
      await setRole("owner");
    }
  });
});
