/**
 * Certifies 0.2.0 Portfolio schema & instruments against the real process (ADR 0007, #503): the
 * actual server (main.ts) as a subprocess, driven over real HTTP connections, not
 * buildApp()+inject().
 *
 * A mixed household, written by hand: an `IT` workspace whose budget funds an off-budget,
 * administered brokerage account through an "Investments" category, then buys in two portfolios,
 * a sale with gain tax, a dividend with foreign and domestic withholding, a split covering both
 * portfolios, a transfer of units between them, a government bond bought with accrued interest, a
 * custody fee, an edit and a delete. Positions are read back per portfolio and per account, and
 * the cash and the budget are checked against the money that moved.
 *
 * Every expected number below is worked out by hand from the trades, with its arithmetic in a
 * comment, never copied from a previous run (ADR 0007): the numbers are numeric, but a scripted
 * scenario whose arithmetic can be followed line by line is what this milestone's surface needs
 * (the maintainer settled this on #503; a seeded random walk can come with #80's generator).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";

import { decodeJwt } from "jose";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { ensureQueueRoleLogin, queueConnectionString } from "../test-helpers/queue-role.ts";
import { TEST_VAPID_PRIVATE_KEY, TEST_VAPID_PUBLIC_KEY, TEST_VAPID_SUBJECT } from "../test-helpers/vapid-keys.ts";
import { printServerOutputOnFailure, startServer, type RunningServer } from "./support.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}
if (!process.env.KEYCLOAK_ADMIN_PASSWORD) {
  throw new Error("Set KEYCLOAK_ADMIN_PASSWORD (the value from infra/.env) before running the integration tests");
}

/** Names this run's catalog rows (`Smoke 0.2.0 <hex>`), so a run killed before its `after` leaves findable leftovers. */
const RUN_PREFIX = `Smoke 0.2.0 ${randomBytes(4).toString("hex")}`;

/** Units × 10^8 (ADR 0011). */
const units = (n: number): number => n * 100_000_000;
/** A price × 10^6 (ADR 0011), from a price written with at most 6 decimals. */
const price = (p: number): number => Math.round(p * 1_000_000);

interface Trade {
  readonly id: string;
  readonly type: string;
  readonly portfolioId: string;
  readonly grossCents: number;
  readonly cashCents: number;
  readonly cashTransactionId: string | null;
  readonly locked: boolean;
}

interface Transaction {
  readonly id: string;
  readonly status: string;
  readonly tradeId: string | null;
  readonly splits: readonly { readonly amountCents: number }[];
}

interface BudgetMonth {
  readonly unassigned: number;
  readonly assignedInFuture: number;
  readonly creditOverspending: number;
  readonly categories: readonly { readonly categoryId: string; readonly activity: number; readonly available: number }[];
  readonly paymentCategories: readonly { readonly available: number }[];
}

type Totals = Record<string, number>;

interface PositionRow {
  readonly accountId: string;
  readonly instrument: { readonly id: string };
  readonly currency: string;
  readonly quantityE8: number;
  readonly costBasisCents: number;
  readonly accountAverageCostE6: number | null;
}
interface Positions {
  readonly positions: readonly (PositionRow & Totals)[];
  readonly summaries: readonly ({ readonly currency: string; readonly costBasisCents: number } & Totals)[];
}

/**
 * Every total a position and a summary carry, all zero: each expectation below starts from these
 * and names only what its trades make non-zero, so a total that should have stayed at zero is
 * checked too.
 */
const ZERO_TOTALS: Totals = {
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

/** The fields of `actual` that `expected` names, so a comparison is not broken by catalog fields. */
function pick(actual: Record<string, unknown>, expected: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]));
}

describe("smoke: 0.2.0 Portfolio schema & instruments, against the real process", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let server: RunningServer;
  let ownerToken: string;
  let workspaceId: string | undefined;
  const otherWorkspaceIds: string[] = [];
  const instrumentIds: string[] = [];
  const tickers = new Map<string, string>();

  afterEach(printServerOutputOnFailure(() => [server]));

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    await ensureQueueRoleLogin(superuserPool);
    realm = await setUpKeycloakTestRealm();

    server = await startServer({
      HOST: "127.0.0.1",
      APP_DATABASE_URL: appConnectionString(databaseUrl),
      QUEUE_DATABASE_URL: queueConnectionString(databaseUrl),
      VAPID_SUBJECT: TEST_VAPID_SUBJECT,
      VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
      KEYCLOAK_ISSUER: realm.issuer,
      KEYCLOAK_AUDIENCE: realm.audience,
      LOG_LEVEL: "fatal",
    });

    ownerToken = await realm.getUserToken();
    // The workspace is created over HTTP too, so its creator becomes its owner the way a real one does.
    const created = await send(ownerToken, "POST", "/workspaces", { name: "Household", baseCurrency: "EUR", timeZone: "Europe/Rome" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body as { id: string }).id;
  });

  after(async () => {
    // Each step is guarded, so a `before` that failed half-way still releases what it got and its
    // own error is the one reported.
    try {
      await server?.stop();
      // Trades reference instruments with ON DELETE RESTRICT: the workspaces go first.
      const workspaceIds = [workspaceId, ...otherWorkspaceIds].filter((id): id is string => id !== undefined);
      if (superuserPool && workspaceIds.length > 0) {
        await superuserPool.query("DELETE FROM workspaces WHERE id = ANY($1)", [workspaceIds]);
      }
      if (superuserPool && instrumentIds.length > 0) {
        await superuserPool.query("DELETE FROM instruments WHERE id = ANY($1)", [instrumentIds]);
      }
    } finally {
      await realm?.teardown();
      await superuserPool?.end();
    }
  });

  async function send(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${server.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
  }

  /** A request to the household's workspace as its owner, which must succeed. */
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await send(ownerToken, method, `/workspaces/${workspaceId!}${path}`, body);
    if (response.status >= 300) {
      throw new Error(`${method} ${path} responded ${response.status}: ${JSON.stringify(response.body)}`);
    }
    return response.body as T;
  }

  async function createInstrument(name: string, type: string, priceFactorE6: number): Promise<string> {
    // The catalog is shared by every workspace and run, and nothing deletes from it but this test's
    // own `after`: a random ticker keeps runs apart, and the run's prefix on the name lets a killed
    // run's leftovers be found.
    const ticker = `S${randomBytes(5).toString("hex").toUpperCase()}`;
    const response = await send(ownerToken, "POST", "/instruments", {
      ticker,
      exchange: "XMIL",
      name: `${RUN_PREFIX} ${name}`,
      type,
      currency: "EUR",
      priceFactorE6,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const id = (response.body as { id: string }).id;
    instrumentIds.push(id);
    tickers.set(id, ticker);
    return id;
  }

  async function postTrade(body: Record<string, unknown>): Promise<Trade[]> {
    return (await api<{ trades: Trade[] }>("POST", "/trades", body)).trades;
  }

  async function balanceOf(accountId: string): Promise<number> {
    const { transactions } = await api<{ transactions: Transaction[] }>("GET", `/accounts/${accountId}/transactions`);
    return transactions.reduce((sum, t) => sum + t.splits.reduce((s, split) => s + split.amountCents, 0), 0);
  }

  /** A user with a token of their own and a local `users` row, created by their first request. */
  async function newUser(): Promise<{ token: string; userId: string }> {
    const token = await realm.getTokenForNewUser();
    await send(token, "GET", "/me/workspaces");
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [decodeJwt(token).sub]);
    assert.ok(rows[0], "expected the user mapper to have created a local user for this token's subject");
    return { token, userId: rows[0].id };
  }

  it("runs a mixed household's budget and portfolios end to end, and every figure adds up", async () => {
    // --- 1. An IT workspace, a checking account on budget and an administered brokerage account off budget.
    await api("PATCH", "", { taxCountry: "IT" });
    const checking = (await api<{ id: string }>("POST", "/accounts", { name: "Checking", type: "checking", currency: "EUR" })).id;
    const broker = await api<{ id: string; onBudget: boolean; domesticWithholdingAgent: boolean }>("POST", "/accounts", {
      name: "Broker",
      type: "brokerage",
      currency: "EUR",
      taxRegime: "administered",
      taxRegimeValidFrom: "2026-01-01",
      domesticWithholdingAgent: true,
    });
    assert.equal(broker.onBudget, false);
    assert.equal(broker.domesticWithholdingAgent, true);
    const brokerId = broker.id;
    assert.deepEqual(await api("GET", `/accounts/${brokerId}/tax-regimes`), {
      taxRegimes: [{ validFrom: "2026-01-01", regime: "administered" }],
    });

    // --- 2. The budget: income, an "Investments" category funded, then the transfer to the broker.
    const groupId = (await api<{ id: string }>("POST", "/category-groups", { name: "Goals" })).id;
    const investments = (await api<{ id: string }>("POST", "/categories", { name: "Investments", groupId })).id;
    const groceries = (await api<{ id: string }>("POST", "/categories", { name: "Groceries", groupId })).id;
    await api("POST", `/accounts/${checking}/transactions`, { occurredAt: "2026-03-02", splits: [{ categoryId: null, amountCents: 4_000_000 }] });
    await api("POST", `/accounts/${checking}/transactions`, { occurredAt: "2026-03-05", splits: [{ categoryId: groceries, amountCents: -12_345 }] });
    await api("POST", "/assignments", {
      entries: [
        { month: "2026-03", sourceCategoryId: null, destinationCategoryId: investments, amountCents: 3_000_000 },
        { month: "2026-03", sourceCategoryId: null, destinationCategoryId: groceries, amountCents: 50_000 },
      ],
    });
    const marchBeforeTransfer = await api<BudgetMonth>("GET", "/budget-months/2026-03");

    const transfer = await api<{ destination: { id: string } }>("POST", "/transfers", {
      sourceAccountId: checking,
      destinationAccountId: brokerId,
      occurredAt: "2026-03-10",
      amountCents: 3_000_000,
      categoryId: investments,
    });
    const marchBeforeTrades = await api<BudgetMonth>("GET", "/budget-months/2026-03");
    const aprilBeforeTrades = await api<BudgetMonth>("GET", "/budget-months/2026-04");

    // The transfer is spending from "Investments", and nothing else in the budget moves.
    const shifted = {
      ...marchBeforeTransfer,
      categories: marchBeforeTransfer.categories.map((c) =>
        c.categoryId === investments ? { ...c, activity: c.activity - 3_000_000, available: c.available - 3_000_000 } : c,
      ),
    };
    assert.deepEqual(marchBeforeTrades, shifted);

    // --- 3. Instruments: an ETF, a stock, and a government bond quoted in percent of nominal.
    const etf = await createInstrument("World equity ETF", "fund", 1_000_000);
    const stock = await createInstrument("Utility share", "stock", 1_000_000);
    const bond = await createInstrument("Treasury bond 2031", "government_bond", 10_000);

    // --- 4. Two portfolios and their trades.
    const growth = (await api<{ id: string }>("POST", "/portfolios", { name: "Growth" })).id;
    const income = (await api<{ id: string }>("POST", "/portfolios", { name: "Income", purpose: "Coupons and dividends" })).id;
    const onBroker = { accountId: brokerId };

    // Growth buys 20 ETF at €100.00, €5 fee: gross 2,000.00; cash −(2,000.00 + 5.00) = −2,005.00.
    const [etfBuyGrowth] = await postTrade({ ...onBroker, portfolioId: growth, type: "buy", instrumentId: etf, tradeDate: "2026-03-12", quantityE8: units(20), priceE6: price(100), feesCents: 500 });
    assert.equal(etfBuyGrowth!.grossCents, 200_000);
    assert.equal(etfBuyGrowth!.cashCents, -200_500);

    // Income buys 30 ETF at €120.00, €5 fee: gross 3,600.00; cash −3,605.00.
    // The account now holds 50 ETF for 2,005.00 + 3,605.00 = €5,610.00.
    const [etfBuyIncome] = await postTrade({ ...onBroker, portfolioId: income, type: "buy", instrumentId: etf, tradeDate: "2026-03-13", quantityE8: units(30), priceE6: price(120), feesCents: 500 });
    assert.equal(etfBuyIncome!.cashCents, -360_500);

    // Growth buys 100 shares at €50.00, €5 fee (cash −5,005.00), then the buy is corrected below.
    const [stockBuy] = await postTrade({ ...onBroker, portfolioId: growth, type: "buy", instrumentId: stock, tradeDate: "2026-03-16", quantityE8: units(100), priceE6: price(50), feesCents: 500 });
    assert.equal(stockBuy!.cashCents, -500_500);

    // Income buys 10 shares at €55.00 by mistake (cash −550.00): deleted below, with its cash leg.
    const [mistake] = await postTrade({ ...onBroker, portfolioId: income, type: "buy", instrumentId: stock, tradeDate: "2026-03-17", quantityE8: units(10), priceE6: price(55) });
    assert.equal(mistake!.cashCents, -55_000);

    // Growth sells 10 ETF at €130.00, €5 fee. Cost removed: 5,610.00 × 10 ÷ 50 = €1,122.00.
    // Gain: 1,300.00 − 5.00 − 1,122.00 = €173.00; gain tax 26%: 173.00 × 0.26 = €44.98.
    // Cash: 1,300.00 − 5.00 − 44.98 = +1,250.02. The account keeps 40 ETF for €4,488.00
    // (Growth 10, Income 30).
    const [etfSell] = await postTrade({ ...onBroker, portfolioId: growth, type: "sell", instrumentId: etf, tradeDate: "2026-03-20", quantityE8: units(10), priceE6: price(130), feesCents: 500, gainTaxCents: 4_498 });
    assert.equal(etfSell!.cashCents, 125_002);

    // The share buy was really 80 shares with a €4 fee: gross 80 × 50.00 = 4,000.00, cost 4,004.00, cash −4,004.00.
    const [stockEdited] = (await api<{ trades: Trade[] }>("PATCH", `/trades/${stockBuy!.id}`, { quantityE8: units(80), feesCents: 400 })).trades;
    assert.equal(stockEdited!.grossCents, 400_000);
    assert.equal(stockEdited!.cashCents, -400_400);

    const deleted = await send(ownerToken, "DELETE", `/workspaces/${workspaceId}/trades/${mistake!.id}`);
    assert.equal(deleted.status, 204);

    // A €40.00 dividend on Growth's shares: €6.00 foreign withholding, then 26% domestic on the
    // €34.00 left (34.00 × 0.26 = €8.84), and a €1.00 fee. Net: 40.00 − 6.00 − 8.84 − 1.00 = +€24.16.
    const [dividend] = await postTrade({ ...onBroker, portfolioId: growth, type: "dividend", instrumentId: stock, tradeDate: "2026-04-01", grossCents: 4_000, withholdingForeignCents: 600, withholdingDomesticCents: 884, feesCents: 100 });
    assert.equal(dividend!.cashCents, 2_416);

    // A 1:2 split of the ETF, entered once: one row per portfolio holding it (Growth 10 → 20,
    // Income 30 → 60). The cost stays €4,488.00, now on 80 units: an average of €56.10. No cash.
    const splitRows = await postTrade({ type: "split", instrumentId: etf, tradeDate: "2026-04-10", splitFrom: 1, splitTo: 2 });
    assert.deepEqual(splitRows.map((row) => row.portfolioId).sort(), [growth, income].sort());
    assert.ok(splitRows.every((row) => row.cashCents === 0 && row.cashTransactionId === null));

    // Income moves 5 ETF to Growth in the same account, with a €1.50 fee on the outgoing leg:
    // Growth 25, Income 55, the cost and the average unchanged; cash −1.50.
    const transferLegs = await postTrade({
      type: "transfer",
      instrumentId: etf,
      tradeDate: "2026-04-20",
      quantityE8: units(5),
      from: { ...onBroker, portfolioId: income, feesCents: 150 },
      to: { ...onBroker, portfolioId: growth },
    });
    assert.equal(transferLegs.length, 2);
    assert.equal(transferLegs.reduce((sum, leg) => sum + leg.cashCents, 0), -150);

    // Income buys 10,000 nominal of the bond at 99.50 (price factor 0.01): gross
    // 10,000 × 99.50 × 0.01 = €9,950.00, €2.00 fee, €40.00 of accrued interest paid and 12.5% of it
    // credited back (40.00 × 0.125 = €5.00). Cash: −(9,950.00 + 2.00 + 40.00 − 5.00) = −€9,987.00;
    // cost 9,950.00 + 2.00 = €9,952.00, an average of 99.52 (percent of nominal).
    const [bondBuy] = await postTrade({ ...onBroker, portfolioId: income, type: "buy", instrumentId: bond, tradeDate: "2026-04-15", quantityE8: units(10_000), priceE6: price(99.5), feesCents: 200, accruedInterestCents: 4_000, withholdingDomesticCents: 500 });
    assert.equal(bondBuy!.grossCents, 995_000);
    assert.equal(bondBuy!.cashCents, -998_700);

    // A €3.50 custody fee on Growth, with no instrument.
    const [custody] = await postTrade({ ...onBroker, portfolioId: growth, type: "fee", tradeDate: "2026-04-30", feesCents: 350 });
    assert.equal(custody!.cashCents, -350);

    const { trades } = await api<{ trades: Trade[] }>("GET", "/trades");
    assert.ok(!trades.some((t) => t.id === mistake!.id), "the deleted trade is gone");
    // 2 ETF buys, 1 share buy, 1 sale, 1 dividend, 2 split rows, 2 transfer legs, 1 bond buy, 1 fee.
    assert.equal(trades.length, 11);

    // --- 5a. Positions per portfolio.
    const growthPositions = await api<Positions>("GET", `/portfolios/${growth}/positions`);
    const incomePositions = await api<Positions>("GET", `/portfolios/${income}/positions`);
    const accountPositions = await api<Positions>("GET", `/accounts/${brokerId}/positions`);

    const position = (result: Positions, instrumentId: string) => {
      const row = result.positions.find((p) => p.instrument.id === instrumentId);
      assert.ok(row, `expected a position of ${instrumentId}`);
      return row;
    };
    const expectPosition = (result: Positions, instrumentId: string, expected: Record<string, unknown>): void => {
      const full = { accountId: brokerId, currency: "EUR", ...ZERO_TOTALS, ...expected };
      assert.deepEqual(pick(position(result, instrumentId), full), full, `position of ${instrumentId}`);
    };
    const expectSummary = (result: Positions, expected: Record<string, unknown>): void => {
      assert.equal(result.summaries.length, 1);
      const full = { currency: "EUR", ...ZERO_TOTALS, ...expected };
      assert.deepEqual(pick(result.summaries[0]!, full), full);
    };

    // Growth's ETF: 25 of the account's 80 units, so 4,488.00 × 25 ÷ 80 = €1,402.50 of the cost.
    // Its own trades: cost in 2,005.00, cost sold 1,122.00, gain 173.00 and its 44.98 of tax, fees 5 + 5.
    expectPosition(growthPositions, etf, {
      quantityE8: units(25),
      costBasisCents: 140_250,
      accountAverageCostE6: price(56.1),
      realizedCents: 17_300,
      costInCents: 200_500,
      costSoldCents: 112_200,
      tradeFeesCents: 1_000,
      gainTaxWithheldCents: 4_498,
      taxesOnGainsCents: 4_498,
    });
    // Growth's shares: 80 for €4,004.00, an average of 4,004.00 ÷ 80 = €50.05; the dividend's
    // income 40.00 − 6.00 − 8.84 − 1.00 = €24.16.
    expectPosition(growthPositions, stock, {
      quantityE8: units(80),
      costBasisCents: 400_400,
      accountAverageCostE6: price(50.05),
      costInCents: 400_400,
      tradeFeesCents: 400,
      incomeGrossCents: 4_000,
      withholdingForeignCents: 600,
      withholdingDomesticCents: 884,
      incomeFeesCents: 100,
      incomeCents: 2_416,
    });
    assert.equal(growthPositions.positions.length, 2);
    // Growth in total: cost 1,402.50 + 4,004.00 = €5,406.50; the custody fee is a cost of its own.
    expectSummary(growthPositions, {
      costBasisCents: 540_650,
      realizedCents: 17_300,
      costInCents: 600_900,
      costSoldCents: 112_200,
      tradeFeesCents: 1_400,
      gainTaxWithheldCents: 4_498,
      incomeGrossCents: 4_000,
      withholdingForeignCents: 600,
      withholdingDomesticCents: 884,
      incomeFeesCents: 100,
      standaloneFeesCents: 350,
      incomeCents: 2_416,
      costsCents: 350,
      taxesOnGainsCents: 4_498,
    });

    // Income's ETF: 55 units, 4,488.00 × 55 ÷ 80 = €3,085.50 of the cost, and the transfer's €1.50 fee.
    expectPosition(incomePositions, etf, {
      quantityE8: units(55),
      costBasisCents: 308_550,
      accountAverageCostE6: price(56.1),
      costInCents: 360_500,
      tradeFeesCents: 500,
      transferFeesCents: 150,
      costsCents: 150,
    });
    // Income's bond: the accrued interest paid and the withholding credited back are income:
    // 0 − (−5.00) − 40.00 = −€35.00.
    expectPosition(incomePositions, bond, {
      quantityE8: units(10_000),
      costBasisCents: 995_200,
      accountAverageCostE6: price(99.52),
      costInCents: 995_200,
      tradeFeesCents: 200,
      accruedInterestPaidCents: 4_000,
      withholdingDomesticCents: -500,
      incomeCents: -3_500,
    });
    // The deleted share buy leaves Income no position in the shares.
    assert.equal(incomePositions.positions.length, 2);
    expectSummary(incomePositions, {
      costBasisCents: 308_550 + 995_200,
      costInCents: 360_500 + 995_200,
      tradeFeesCents: 700,
      transferFeesCents: 150,
      accruedInterestPaidCents: 4_000,
      withholdingDomesticCents: -500,
      incomeCents: -3_500,
      costsCents: 150,
    });

    // --- 5b. Positions per account: the two portfolios together, the cost shares adding back up.
    expectPosition(accountPositions, etf, {
      quantityE8: units(80),
      costBasisCents: 448_800,
      accountAverageCostE6: price(56.1),
      realizedCents: 17_300,
      costInCents: 561_000,
      costSoldCents: 112_200,
      tradeFeesCents: 1_500,
      transferFeesCents: 150,
      gainTaxWithheldCents: 4_498,
      costsCents: 150,
      taxesOnGainsCents: 4_498,
    });
    // The portfolios' cost shares, as the API returns them, add up to the account's cost.
    assert.equal(
      position(growthPositions, etf).costBasisCents + position(incomePositions, etf).costBasisCents,
      position(accountPositions, etf).costBasisCents,
    );
    expectPosition(accountPositions, stock, {
      quantityE8: units(80),
      costBasisCents: 400_400,
      accountAverageCostE6: price(50.05),
      costInCents: 400_400,
      tradeFeesCents: 400,
      incomeGrossCents: 4_000,
      withholdingForeignCents: 600,
      withholdingDomesticCents: 884,
      incomeFeesCents: 100,
      incomeCents: 2_416,
    });
    expectPosition(accountPositions, bond, {
      quantityE8: units(10_000),
      costBasisCents: 995_200,
      accountAverageCostE6: price(99.52),
      costInCents: 995_200,
      tradeFeesCents: 200,
      accruedInterestPaidCents: 4_000,
      withholdingDomesticCents: -500,
      incomeCents: -3_500,
    });
    assert.equal(accountPositions.positions.length, 3);
    // --- 5c. Derived results of the account: income 24.16 − 35.00 = −€10.84; costs 1.50 + 3.50 = €5.00;
    // taxes on gains €44.98; cost 4,488.00 + 4,004.00 + 9,952.00 = €18,444.00.
    expectSummary(accountPositions, {
      costBasisCents: 1_844_400,
      realizedCents: 17_300,
      costInCents: 561_000 + 400_400 + 995_200,
      costSoldCents: 112_200,
      tradeFeesCents: 2_100,
      transferFeesCents: 150,
      gainTaxWithheldCents: 4_498,
      incomeGrossCents: 4_000,
      withholdingForeignCents: 600,
      withholdingDomesticCents: 884 - 500,
      incomeFeesCents: 100,
      accruedInterestPaidCents: 4_000,
      standaloneFeesCents: 350,
      incomeCents: -1_084,
      costsCents: 500,
      taxesOnGainsCents: 4_498,
    });

    // --- 5d. The brokerage cash: the deposit plus every cash leg.
    // 30,000.00 − 2,005.00 − 3,605.00 − 4,004.00 + 1,250.02 + 24.16 − 1.50 − 9,987.00 − 3.50 = €11,668.18.
    const brokerBalance = await balanceOf(brokerId);
    assert.equal(brokerBalance, 1_166_818);
    const { transactions: brokerTransactions } = await api<{ transactions: Transaction[] }>("GET", `/accounts/${brokerId}/transactions`);
    const deposit = brokerTransactions.find((t) => t.id === transfer.destination.id);
    assert.ok(deposit, "expected the transfer's leg on the brokerage account");
    const depositCents = deposit.splits.reduce((sum, split) => sum + split.amountCents, 0);
    assert.equal(depositCents, 3_000_000);
    assert.equal(brokerBalance, depositCents + trades.reduce((sum, t) => sum + t.cashCents, 0));
    // The domain guide's "the account adds up": realized + income − costs − taxes on gains
    // = (cash + cost) − money transferred in: 173.00 − 10.84 − 5.00 − 44.98 = 112.18
    // = 11,668.18 + 18,444.00 − 30,000.00, every term read from the API.
    const accountSummary = accountPositions.summaries[0]!;
    assert.equal(
      accountSummary.realizedCents! + accountSummary.incomeCents! - accountSummary.costsCents! - accountSummary.taxesOnGainsCents!,
      brokerBalance + accountSummary.costBasisCents - depositCents,
    );

    // --- 5e. The budget never sees a trade: both months are exactly as they were before the trades.
    assert.deepEqual(await api<BudgetMonth>("GET", "/budget-months/2026-03"), marchBeforeTrades);
    assert.deepEqual(await api<BudgetMonth>("GET", "/budget-months/2026-04"), aprilBeforeTrades);

    // --- 5f. The budget invariant on the on-budget account.
    // Checking: 40,000.00 − 123.45 − 30,000.00 = €9,876.55. Unassigned 40,000.00 − 30,000.00 − 500.00
    // = €9,500.00; Investments 30,000.00 − 30,000.00 = 0; Groceries 500.00 − 123.45 = €376.55.
    const march = await api<BudgetMonth>("GET", "/budget-months/2026-03");
    const checkingBalance = await balanceOf(checking);
    assert.equal(checkingBalance, 987_655);
    assert.equal(march.unassigned, 950_000);
    assert.equal(march.categories.find((c) => c.categoryId === investments)?.available, 0);
    assert.equal(march.categories.find((c) => c.categoryId === groceries)?.available, 37_655);
    const budgeted =
      march.unassigned +
      [...march.categories, ...march.paymentCategories].reduce((sum, c) => sum + c.available, 0) +
      march.assignedInFuture +
      march.creditOverspending;
    assert.equal(budgeted, checkingBalance);

    // --- 5g. A reconciled cash leg locks its trade. The broker's statement of 12 March shows the
    // deposit and Growth's first buy: 30,000.00 − 2,005.00 = €27,995.00.
    for (const transactionId of [transfer.destination.id, etfBuyGrowth!.cashTransactionId!]) {
      await api("PATCH", `/accounts/${brokerId}/transactions/${transactionId}`, { status: "cleared" });
    }
    const reconciliation = await api<{ outcome: string }>("POST", `/accounts/${brokerId}/reconciliations`, {
      date: "2026-03-12",
      statementBalanceCents: 2_799_500,
      tickedTransactionIds: [transfer.destination.id, etfBuyGrowth!.cashTransactionId],
    });
    assert.equal(reconciliation.outcome, "reconciled");
    const locked = (await api<{ trades: Trade[] }>("GET", "/trades")).trades;
    assert.deepEqual(locked.filter((t) => t.locked).map((t) => t.id), [etfBuyGrowth!.id]);
    const refusedEdit = await send(ownerToken, "PATCH", `/workspaces/${workspaceId}/trades/${etfBuyGrowth!.id}`, { feesCents: 0 });
    assert.equal(refusedEdit.status, 409);
    assert.equal((refusedEdit.body as { code: string }).code, "reconciled");
    const refusedDelete = await send(ownerToken, "DELETE", `/workspaces/${workspaceId}/trades/${etfBuyGrowth!.id}`);
    assert.equal(refusedDelete.status, 409);
    assert.equal((refusedDelete.body as { code: string }).code, "reconciled");
    assert.deepEqual(await api("GET", `/accounts/${brokerId}/positions`), accountPositions);

    // --- 5h. A read_only member reads everything and writes nothing.
    const reader = await newUser();
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'read_only')", [reader.userId, workspaceId]);
    const asReader = (method: string, path: string, body?: unknown) => send(reader.token, method, `/workspaces/${workspaceId}${path}`, body);
    const readerPositions = await asReader("GET", `/portfolios/${growth}/positions`);
    assert.equal(readerPositions.status, 200);
    assert.deepEqual(readerPositions.body, growthPositions);
    assert.equal((await asReader("GET", "/trades")).status, 200);
    assert.equal((await asReader("GET", `/accounts/${brokerId}/positions`)).status, 200);
    const readerWrites = [
      await asReader("POST", "/trades", { ...onBroker, portfolioId: growth, type: "fee", tradeDate: "2026-05-01", feesCents: 100 }),
      await asReader("PATCH", `/trades/${dividend!.id}`, { feesCents: 0 }),
      await asReader("DELETE", `/trades/${custody!.id}`),
      await asReader("POST", "/portfolios", { name: "Reader's" }),
    ];
    assert.deepEqual(readerWrites.map((r) => r.status), [403, 403, 403, 403]);

    // --- 5i. Another household's workspace sees none of it.
    const neighbour = await newUser();
    const theirs = await send(neighbour.token, "POST", "/workspaces", { name: "Neighbours", baseCurrency: "EUR", timeZone: "Europe/Rome" });
    assert.equal(theirs.status, 201);
    const theirId = (theirs.body as { id: string }).id;
    otherWorkspaceIds.push(theirId);
    const asNeighbour = (method: string, path: string, body?: unknown) => send(neighbour.token, method, `/workspaces/${theirId}${path}`, body);
    assert.deepEqual((await asNeighbour("GET", "/portfolios?includeArchived=true")).body, { portfolios: [] });
    assert.deepEqual((await asNeighbour("GET", "/trades")).body, { trades: [] });
    assert.equal((await asNeighbour("GET", `/portfolios/${growth}`)).status, 404);
    assert.equal((await asNeighbour("GET", `/portfolios/${growth}/positions`)).status, 404);
    assert.equal((await asNeighbour("GET", `/accounts/${brokerId}/positions`)).status, 404);
    assert.equal((await asNeighbour("PATCH", `/trades/${dividend!.id}`, { feesCents: 0 })).status, 404);
    assert.equal((await asNeighbour("DELETE", `/trades/${dividend!.id}`)).status, 404);
    const intoOurs = await asNeighbour("POST", "/trades", { ...onBroker, portfolioId: growth, type: "fee", tradeDate: "2026-05-01", feesCents: 100 });
    assert.equal(intoOurs.status, 400, JSON.stringify(intoOurs.body));
    // The instruments catalog is shared: both households find the bond by its ticker.
    for (const token of [ownerToken, neighbour.token]) {
      const found = await send(token, "GET", `/instruments?q=${tickers.get(bond)!}`);
      assert.equal(found.status, 200);
      assert.deepEqual(
        (found.body as { instruments: { id: string; name: string }[] }).instruments.map((i) => [i.id, i.name]),
        [[bond, `${RUN_PREFIX} Treasury bond 2031`]],
      );
    }
    // Nor can they reach the household's workspace itself.
    assert.equal((await send(neighbour.token, "GET", `/workspaces/${workspaceId}/trades`)).status, 403);
    // And nothing they tried changed anything here.
    assert.deepEqual((await api<{ trades: Trade[] }>("GET", "/trades")).trades, locked);
  });
});
