import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { App } from "../app.ts";
import type { DbPool } from "../db/pool.ts";
import { setupIntegrationTest, teardownIntegrationTest, type IntegrationTestContext } from "../test-helpers/integration-setup.ts";

/**
 * `GET /fx-rates` (#85). The test database is shared with other files and outlives a run, so this
 * file's rates are on days in 1901, which nothing else stores, and are removed afterwards.
 */
describe("fx-rates route (#85)", () => {
  let ctx: IntegrationTestContext;
  let app: App;
  let superuserPool: DbPool;
  let outsiderToken: string;

  before(async () => {
    ctx = await setupIntegrationTest({ workspaceName: "Rates" });
    ({ app, superuserPool } = ctx);
    await superuserPool.query(
      `INSERT INTO fx_rates (base_currency, quote_currency, rate_date, rate_e10, source) VALUES
         ('EUR', 'USD', '1901-01-03', 10990000000, 'ecb'),
         ('EUR', 'USD', '1901-01-02', 10812000000, 'ecb'),
         ('EUR', 'USD', '1901-01-04', 9007199254740991, 'ecb'),
         ('EUR', 'GBP', '1901-01-02', 8450000000, 'ecb')
       ON CONFLICT DO NOTHING`,
    );
    // A signed-in user who is a member of no workspace at all: rates belong to none.
    outsiderToken = await ctx.realm.getTokenForNewUser();
    await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${outsiderToken}` } });
  });

  after(async () => {
    await superuserPool.query("DELETE FROM fx_rates WHERE rate_date < '1902-01-01'");
    await teardownIntegrationTest(ctx);
  });

  /** `token` null sends no token at all. */
  function get(url: string, token: string | null = ctx.token) {
    return app.fastify.inject({ method: "GET", url, ...(token !== null ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  }

  it("needs a token", async () => {
    const response = await get("/fx-rates?quote=USD", null);
    assert.equal(response.statusCode, 401);
  });

  it("returns one currency's rates between two days, oldest first, exactly as stored", async () => {
    const response = await get("/fx-rates?quote=USD&from=1901-01-01&to=1901-12-31");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      base: "EUR",
      quote: "USD",
      rates: [
        { date: "1901-01-02", rateE10: 10_812_000_000 },
        { date: "1901-01-03", rateE10: 10_990_000_000 },
        { date: "1901-01-04", rateE10: Number.MAX_SAFE_INTEGER },
      ],
    });
  });

  it("includes both bounds, and either may be left out", async () => {
    const both = await get("/fx-rates?quote=USD&from=1901-01-03&to=1901-01-03");
    assert.deepEqual(both.json().rates, [{ date: "1901-01-03", rateE10: 10_990_000_000 }]);
    const toOnly = await get("/fx-rates?quote=USD&to=1901-01-02");
    assert.deepEqual(toOnly.json().rates, [{ date: "1901-01-02", rateE10: 10_812_000_000 }]);
    const fromOnly = await get("/fx-rates?quote=GBP&from=1901-01-01&to=");
    assert.equal(fromOnly.statusCode, 200);
    assert.ok(fromOnly.json().rates.some((r: { date: string }) => r.date === "1901-01-02"));
  });

  it("answers any signed-in user, member of a workspace or not", async () => {
    const response = await get("/fx-rates?quote=GBP&from=1901-01-01&to=1901-12-31", outsiderToken);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().rates, [{ date: "1901-01-02", rateE10: 8_450_000_000 }]);
  });

  it("answers an empty list for a currency with no stored rate", async () => {
    const response = await get("/fx-rates?quote=CHF&from=1901-01-01&to=1901-12-31");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { base: "EUR", quote: "CHF", rates: [] });
  });

  it("refuses a missing, unknown, lower-case or repeated currency, and the euro itself (invalid_currency)", async () => {
    for (const query of ["", "quote=", "quote=XYZ", "quote=usd", "quote=TRL", "quote=EUR", "quote=USD&quote=GBP"]) {
      const response = await get(`/fx-rates?${query}`);
      assert.equal(response.statusCode, 400, query);
      assert.equal(response.json().error, "invalid_currency", query);
    }
  });

  it("refuses a day that is not a calendar date, or a to before from (invalid_date, naming the field)", async () => {
    for (const [query, field] of [
      ["from=1901-02-30", "from"],
      ["to=01-01-1901", "to"],
      ["from=1901-01-01T00:00:00Z", "from"],
      ["from=1901-01-03&to=1901-01-02", "to"],
    ] as const) {
      const response = await get(`/fx-rates?quote=USD&${query}`);
      assert.equal(response.statusCode, 400, query);
      assert.deepEqual([response.json().error, response.json().details.field], ["invalid_date", field], query);
    }
  });
});
