import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { decodeJwt } from "jose";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

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
  readonly averageCostE6: number | null;
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
  readonly gainTaxCents: number;
  readonly dividendsCents: number;
  readonly withholdingForeignCents: number;
  readonly withholdingDomesticCents: number;
  readonly standaloneFeesCents: number;
  readonly standaloneTaxesCents: number;
}

type SummaryBody = Omit<PositionBody, "accountId" | "instrument" | "quantityE8" | "averageCostE6">;

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
  gainTaxCents: 0,
  dividendsCents: 0,
  withholdingForeignCents: 0,
  withholdingDomesticCents: 0,
  standaloneFeesCents: 0,
  standaloneTaxesCents: 0,
};

/** The domain guide's "Income": dividends − withholdings − income fees + accrued interest received − paid. */
function incomeOf(totals: SummaryBody): number {
  return (
    totals.dividendsCents -
    totals.withholdingForeignCents -
    totals.withholdingDomesticCents -
    totals.incomeFeesCents +
    totals.accruedInterestReceivedCents -
    totals.accruedInterestPaidCents
  );
}

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

  async function instrument(currency = "EUR"): Promise<string> {
    const ticker = `T${randomBytes(6).toString("hex").toUpperCase()}`;
    const { rows } = await superuserPool.query<{ id: string }>(
      `INSERT INTO instruments (isin, ticker, exchange, name, type, currency, price_factor_e6)
       VALUES (NULL, $1, 'XMIL', 'Test fund', 'fund', $2, 1000000) RETURNING id`,
      [ticker, currency],
    );
    instrumentIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function account(type = "brokerage", ws = workspaceId): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      `INSERT INTO accounts (workspace_id, name, type, currency, on_budget)
       VALUES ($1, $2, $3, 'EUR', $4) RETURNING id`,
      [ws, `Account ${randomUUID().slice(0, 8)}`, type, type !== "brokerage"],
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

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/portfolios/${randomUUID()}/positions` });
    assert.equal(response.statusCode, 401);
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
        averageCostE6: price(115.25), // the account's average, shared by both portfolios
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
    assert.equal(ofB.positions[0]!.averageCostE6, price(115.25));
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
        averageCostE6: price(115.25),
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
      [ofA, ofB, ofAccount].map((row) => [row!.quantityE8, row!.costBasisCents, row!.averageCostE6, row!.realizedCents]),
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
          averageCostE6: price(115),
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
      ofTarget.positions.map((row) => [row.quantityE8, row.costBasisCents, row.averageCostE6]),
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
          averageCostE6: 54_066_667, // 4,866 ÷ 90, half to even at 6 decimals
          realizedCents: 95_100, // 4,200 − 5 − 3,244
          costInCents: 811_000,
          costSoldCents: 324_400,
          tradeFeesCents: 1_500,
          transactionTaxCents: 500,
          gainTaxCents: 14_726, // 247.26 withheld − 100 refunded
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
        gainTaxCents: 14_726,
        standaloneFeesCents: 300,
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
    assert.equal(position!.dividendsCents, 2_000);
    assert.equal(position!.withholdingForeignCents, 300);
    assert.equal(position!.withholdingDomesticCents, 442);
    assert.equal(position!.incomeFeesCents, 200);
    assert.equal(position!.costBasisCents, 40_500, "a dividend leaves the cost unchanged");
    // €10.58: the €5 fee paid on the buy is not subtracted again.
    assert.equal(incomeOf(position!), 1_058);
    assert.equal(incomeOf(summaries[0]!), 1_058);
  });

  it("keeps a position sold out, for its totals, with no average cost", async () => {
    const etf = await instrument();
    const broker = await account();
    const trading = await portfolio();
    const common = { accountId: broker, portfolioId: trading, instrumentId: etf };
    await trade({ ...common, type: "buy", tradeDate: "2026-01-05", quantityE8: units(2), priceE6: price(10) });
    await trade({ ...common, type: "sell", tradeDate: "2026-01-06", quantityE8: units(2), priceE6: price(12) });

    const [position] = (await positionsOf("portfolios", trading)).positions;
    assert.deepEqual([position!.quantityE8, position!.costBasisCents, position!.averageCostE6, position!.realizedCents], [0, 0, null, 400]);
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

  it("leaves out another workspace's trades of the same catalog instrument", async () => {
    const { etf, a } = await twoPortfolios();
    const other = await addWorkspace("owner");
    const theirAccount = await account("brokerage", other);
    const theirPortfolio = await portfolio(other);
    await trade(
      { type: "buy", accountId: theirAccount, portfolioId: theirPortfolio, instrumentId: etf, tradeDate: "2026-01-06", quantityE8: units(1), priceE6: price(500) },
      other,
    );
    const [position] = (await positionsOf("portfolios", a)).positions;
    assert.deepEqual([position!.costBasisCents, position!.averageCostE6], [57_625, price(115.25)]);
  });

  it("refuses a workspace the user is not a member of", async () => {
    const stranger = randomUUID();
    otherWorkspaceIds.push(stranger);
    await superuserPool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Stranger', 'EUR', 'Europe/Rome')", [stranger]);
    const theirPortfolio = await portfolio(stranger);
    const response = await get(`/portfolios/${theirPortfolio}/positions`, stranger);
    assert.equal(response.statusCode, 403, response.body);
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
