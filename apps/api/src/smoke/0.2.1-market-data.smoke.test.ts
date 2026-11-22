/**
 * Certifies 0.2.1 Market data against the real process (ADR 0007): the actual server (main.ts) as
 * a subprocess, driven over real HTTP connections, not buildApp()+inject().
 *
 * 1. With fetching off (`MARKET_DATA_FETCH_ENABLED=false`): a household's portfolio of a shared
 *    euro ETF priced by hand (`PUT .../prices/:date`) and a private pension fund priced from a CSV
 *    file (`POST .../prices/import`), then its monthly performance (#89), every figure worked out
 *    by hand below. A dollar stock bought in November has no rate yet: November's value is
 *    unknown and says why.
 * 2. With fetching on, against a local server that serves the ECB fixture files
 *    (`MARKET_DATA_ECB_URL`): the startup job stores the rates (`GET /fx-rates`), and November's
 *    value is then known.
 *
 * The exchange rates job writes rates every workspace shares, and the real server runs queue
 * workers: this file runs on a database of its own (`createIsolatedDatabase`), never the run's.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "../test-helpers/isolated-database.ts";
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

const FIXTURES = fileURLToPath(new URL("../market-data/fixtures/", import.meta.url));
/** How long the startup job may take to store the fixture's rates. */
const RATES_TIMEOUT_MS = 30_000;

/** Units × 10^8 (ADR 0011). */
const units = (n: number): number => n * 100_000_000;
/** A price × 10^6 (ADR 0011). */
const price = (p: number): number => Math.round(p * 1_000_000);
const cents = (amount: number): number => Math.round(amount * 100);

interface MonthRow {
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
  readonly missing: readonly Record<string, unknown>[];
}

interface Performance {
  readonly baseCurrency: string;
  readonly months: readonly MonthRow[];
  readonly totals: Record<string, unknown>;
}

describe("smoke: 0.2.1 Market data, against the real process", () => {
  let database: IsolatedDatabase;
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let server: RunningServer | undefined;
  let ratesServer: Server;
  let ratesRequests = 0;
  let token: string;
  let workspaceId: string;
  let serverEnv: Record<string, string>;
  // Shared across the steps below: the portfolio and the dollar stock.
  let portfolioId: string;
  let stockId: string;

  afterEach(printServerOutputOnFailure(() => [server]));

  before(async () => {
    database = await createIsolatedDatabase(databaseUrl);
    superuserPool = createPool(database.databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    await ensureQueueRoleLogin(superuserPool);
    realm = await setUpKeycloakTestRealm();

    // The ECB's two files, served from the fixtures, as XML: the job reads the full history when
    // no rate is stored yet.
    ratesServer = createServer((request, response) => {
      ratesRequests += 1;
      const file = (request.url ?? "").split("/").pop() ?? "";
      const fixture = file === "eurofxref-hist.xml" ? "ecb-hist.xml" : file === "eurofxref-hist-90d.xml" ? "ecb-hist-90d.xml" : null;
      if (fixture === null) {
        response.writeHead(404).end();
        return;
      }
      readFile(`${FIXTURES}${fixture}`).then(
        (body) => response.writeHead(200, { "content-type": "application/xml" }).end(body),
        () => response.writeHead(500).end(),
      );
    });
    await new Promise<void>((resolve) => ratesServer.listen(0, "127.0.0.1", resolve));

    serverEnv = {
      HOST: "127.0.0.1",
      APP_DATABASE_URL: appConnectionString(database.databaseUrl),
      QUEUE_DATABASE_URL: queueConnectionString(database.databaseUrl),
      VAPID_SUBJECT: TEST_VAPID_SUBJECT,
      VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
      KEYCLOAK_ISSUER: realm.issuer,
      KEYCLOAK_AUDIENCE: realm.audience,
      LOG_LEVEL: "warn",
      MARKET_DATA_ECB_URL: `http://127.0.0.1:${(ratesServer.address() as AddressInfo).port}/`,
    };
    server = await startServer({ ...serverEnv, MARKET_DATA_FETCH_ENABLED: "false" });

    token = await realm.getUserToken();
    const created = await send("POST", "/workspaces", { name: "Household", baseCurrency: "EUR", timeZone: "Europe/Rome" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body as { id: string }).id;
  });

  after(async () => {
    // Each step is guarded, so a `before` that failed half-way still releases what it got.
    try {
      await server?.stop();
      await new Promise<void>((resolve) => (ratesServer ? ratesServer.close(() => resolve()) : resolve()));
    } finally {
      try {
        await realm?.teardown();
        await superuserPool?.end();
      } finally {
        // The instruments live in this database too: dropping it removes everything the file made.
        await database?.drop();
      }
    }
  });

  async function send(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${server!.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": contentType }) },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
  }

  /** A request to the household's workspace, which must succeed. */
  async function api<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T> {
    const response = await send(method, `/workspaces/${workspaceId}${path}`, body, contentType);
    if (response.status >= 300) {
      throw new Error(`${method} ${path} responded ${response.status}: ${JSON.stringify(response.body)}`);
    }
    return response.body as T;
  }

  async function performance(from: string, to: string): Promise<Performance> {
    return api<Performance>("GET", `/portfolios/${portfolioId}/performance?from=${from}&to=${to}`);
  }

  it("with fetching off: prices by hand and from a file, then the monthly performance", async () => {
    // The ECB fixture server must not have been asked for anything.
    assert.equal(ratesRequests, 0);

    const response = await send("POST", "/instruments", {
      ticker: `S${randomBytes(5).toString("hex").toUpperCase()}`,
      exchange: "XMIL",
      name: "World ETF",
      type: "fund",
      currency: "EUR",
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const etf = (response.body as { id: string }).id;
    const pension = (await api<{ id: string }>("POST", "/instruments", { name: "Pension fund", type: "other", currency: "EUR" })).id;
    const broker = (await api<{ id: string }>("POST", "/accounts", { name: "Broker", type: "brokerage", currency: "EUR" })).id;
    portfolioId = (await api<{ id: string }>("POST", "/portfolios", { name: "Retirement" })).id;

    // 10 Sep: 10 ETF at €100 with a €5 fee (flow €1,005); 5 Oct: 5 units of the pension fund at €200 (flow €1,000).
    await api("POST", "/trades", { type: "buy", accountId: broker, portfolioId, instrumentId: etf, tradeDate: "2026-09-10", quantityE8: units(10), priceE6: price(100), feesCents: 500 });
    await api("POST", "/trades", { type: "buy", accountId: broker, portfolioId, instrumentId: pension, tradeDate: "2026-10-05", quantityE8: units(5), priceE6: price(200) });

    // The ETF by hand; the pension fund from a file, in the Italian format.
    for (const [date, close] of [
      ["2026-09-10", 100],
      ["2026-09-30", 102],
      ["2026-10-30", 101],
    ] as const) {
      await api("PUT", `/instruments/${etf}/prices/${date}`, { closeE6: price(close) });
    }
    const imported = await api<Record<string, number>>("POST", `/instruments/${pension}/prices/import?locale=it`, "date,close\n2026-10-05,200\n2026-10-30,\"210,00\"\n", "text/csv");
    assert.equal(imported.inserted, 2, JSON.stringify(imported));

    const body = await performance("2026-09", "2026-10");
    assert.equal(body.baseCurrency, "EUR");
    // September: 1,000 that evening from 1,005 put in, 1,020 at the end. Gain 1,020 − 0 − 1,005 = 15.
    // TWR (1,000 ÷ 1,005) × (1,020 ÷ 1,000) − 1 = 1.4925%; MWR the same, with one flow.
    // October: 2,020 after the 1,000 put in, then 10 × 101 + 5 × 210 = 2,060. Gain 2,060 − 1,020 − 1,000 = 40.
    // TWR ((2,020 − 1,000) ÷ 1,020) × (2,060 ÷ 2,020) − 1 = 1.9802%; MWR (−1,020 on 30 Sep, −1,000 on 5 Oct,
    // +2,060 on 31 Oct) 2.1537%.
    assert.deepEqual(
      body.months.map((row) => [row.month, row.valuationDate, row.valueCents, row.netContributionsCents, row.incomeCents, row.gainCents, row.twrE6, row.mwrE6]),
      [
        ["2026-09", "2026-09-30", cents(1_020), cents(1_005), 0, cents(15), 14_925, 14_925],
        ["2026-10", "2026-10-31", cents(2_060), cents(1_000), 0, cents(40), 19_802, 21_537],
      ],
    );
    assert.deepEqual(
      body.months.map((row) => [row.oldestPriceDate, row.oldestRateDate, row.missing]),
      [
        ["2026-09-30", null, []],
        ["2026-10-30", null, []],
      ],
    );
    // Both months: gain 55; TWR (1,020 ÷ 1,005) × (2,060 ÷ 2,020) − 1 = 3.5023%; MWR (−1,005 on 10 Sep,
    // −1,000 on 5 Oct, +2,060 on 31 Oct) 3.6416%.
    assert.deepEqual(body.totals, {
      startDate: "2026-08-31",
      endDate: "2026-10-31",
      startValueCents: 0,
      endValueCents: cents(2_060),
      netContributionsCents: cents(2_005),
      incomeCents: 0,
      gainCents: cents(55),
      twrE6: 35_023,
      twrAnnualized: false,
      mwrE6: 36_416,
      mwrAnnualized: false,
      missing: [],
    });

    // A dollar stock bought on 20 November: no rate is stored, so November's value is unknown.
    const stockResponse = await send("POST", "/instruments", {
      ticker: `S${randomBytes(5).toString("hex").toUpperCase()}`,
      exchange: "XNYS",
      name: "Dollar stock",
      type: "stock",
      currency: "USD",
    });
    assert.equal(stockResponse.status, 201, JSON.stringify(stockResponse.body));
    stockId = (stockResponse.body as { id: string }).id;
    const dollarBroker = (await api<{ id: string }>("POST", "/accounts", { name: "Dollar broker", type: "brokerage", currency: "USD" })).id;
    await api("POST", "/trades", { type: "buy", accountId: dollarBroker, portfolioId, instrumentId: stockId, tradeDate: "2026-11-20", quantityE8: units(10), priceE6: price(109.9) });
    await api("PUT", `/instruments/${stockId}/prices/2026-11-20`, { closeE6: price(109.9) });

    const [november] = (await performance("2026-11", "2026-11")).months;
    assert.equal(november?.valueCents, null);
    assert.equal(november?.netContributionsCents, null);
    assert.deepEqual(november?.missing, [{ instrumentId: stockId, reason: "no_rate", currency: "USD" }]);
  });

  it("with fetching on: the startup job stores the ECB rates, and the dollar holding is valued", async () => {
    await server?.stop();
    server = undefined;
    server = await startServer({ ...serverEnv, MARKET_DATA_FETCH_ENABLED: "true" });

    // Wait for the job to store the fixture's rates.
    const deadline = Date.now() + RATES_TIMEOUT_MS;
    let rates: { date: string; rateE10: number }[] = [];
    while (Date.now() < deadline) {
      const response = await send("GET", "/fx-rates?quote=USD&from=2026-11-01");
      assert.equal(response.status, 200, JSON.stringify(response.body));
      rates = (response.body as { rates: { date: string; rateE10: number }[] }).rates;
      if (rates.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(ratesRequests > 0, "the job asked the fixture server for a file");
    assert.deepEqual(rates.at(-1), { date: "2026-11-20", rateE10: 10_990_000_000 });

    // November: 10 ETF at €101 (30 Oct) = 1,010, the pension fund 5 × €210 = 1,050, and $1,099.00
    // at USD 1.099 (20 Nov) = €1,000.00: 3,060. The buy put in $1,099.00 = €1,000.00 on its own
    // date, so the gain is 3,060 − 2,060 − 1,000 = 0, and the TWR 0.
    const [november] = (await performance("2026-11", "2026-11")).months;
    assert.equal(november?.valueCents, cents(3_060));
    assert.equal(november?.netContributionsCents, cents(1_000));
    assert.equal(november?.gainCents, 0);
    assert.equal(november?.twrE6, 0);
    assert.equal(november?.oldestPriceDate, "2026-10-30");
    assert.equal(november?.oldestRateDate, "2026-11-20");
    assert.deepEqual(november?.missing, []);
  });
});
