import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { isinCheckDigit } from "@envelope/core";
import { decodeJwt } from "jose";

import { type App } from "../app.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString } from "../test-helpers/app-role.ts";
import {
  requireIntegrationTestEnv,
  setupIntegrationTest,
  teardownIntegrationTest,
  type IntegrationTestContext,
} from "../test-helpers/integration-setup.ts";

const { databaseUrl } = requireIntegrationTestEnv();

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A fresh, valid ISIN per call: the catalog is shared and the test database outlives a run. */
function randomIsin(): string {
  let body = "XS";
  for (let i = 0; i < 9; i++) {
    body += ALPHANUMERIC[Math.floor(Math.random() * ALPHANUMERIC.length)];
  }
  return `${body}${isinCheckDigit(body)}`;
}

function randomTicker(): string {
  return `T${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

describe("instruments routes (#76)", () => {
  let ctx: IntegrationTestContext;
  let app: App;
  let superuserPool: DbPool;
  let appRolePool: DbPool;
  let tokenA: string;
  let tokenB: string;
  let workspaceB: string;
  // Every instrument this file creates has a name starting with this, so `after` can remove
  // them all and a name-prefix search sees only this run's rows.
  const namePrefix = `Instr${randomUUID().slice(0, 8)}`;

  before(async () => {
    ctx = await setupIntegrationTest({ workspaceName: "Workspace A" });
    ({ app, superuserPool, token: tokenA } = ctx);
    appRolePool = createPool(appConnectionString(databaseUrl));

    // A second user, member of a second workspace only.
    tokenB = await ctx.realm.getTokenForNewUser();
    await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${tokenB}` } });
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      decodeJwt(tokenB).sub,
    ]);
    assert.ok(rows[0], "expected the user mapper to have created the second user");
    workspaceB = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Workspace B', 'EUR', 'Europe/Rome')",
      [workspaceB],
    );
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [
      rows[0].id,
      workspaceB,
    ]);
  });

  after(async () => {
    await superuserPool.query("DELETE FROM instruments WHERE name LIKE $1", [`${namePrefix}%`]);
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceB]);
    await appRolePool.end();
    await teardownIntegrationTest(ctx);
  });

  function post(token: string | undefined, payload: Record<string, unknown>) {
    return app.fastify.inject({
      method: "POST",
      url: "/instruments",
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      payload,
    });
  }

  function get(token: string | undefined, url: string) {
    return app.fastify.inject({ method: "GET", url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  }

  it("rejects every endpoint without a token", async () => {
    const isin = randomIsin();
    assert.equal((await post(undefined, { isin, name: `${namePrefix} x`, type: "fund", currency: "EUR" })).statusCode, 401);
    assert.equal((await get(undefined, `/instruments?q=${isin}`)).statusCode, 401);
    assert.equal((await get(undefined, `/instruments/${randomUUID()}`)).statusCode, 401);
  });

  it("creates an instrument, normalized, without exposing who created it or when, and reads it back", async () => {
    const isin = randomIsin();
    const ticker = randomTicker();
    const created = await post(tokenA, {
      isin: isin.toLowerCase(),
      ticker: ticker.toLowerCase(),
      exchange: "xmil",
      name: `${namePrefix} World equity`,
      type: "fund",
      currency: "eur",
      assetClass: "Stocks",
    });
    assert.equal(created.statusCode, 201);
    const body = created.json();
    assert.deepEqual(
      { ...body, id: undefined },
      {
        id: undefined,
        workspaceId: null,
        isin,
        ticker,
        exchange: "XMIL",
        name: `${namePrefix} World equity`,
        type: "fund",
        currency: "EUR",
        assetClass: "Stocks",
        priceFactorE6: 1_000_000,
      },
    );
    assert.equal("createdBy" in body, false);
    assert.equal("createdAt" in body, false);

    const read = await get(tokenA, `/instruments/${body.id}`);
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), body);

    // created_by is still recorded in the table itself.
    const { rows } = await superuserPool.query<{ created_by: string | null }>(
      "SELECT created_by FROM instruments WHERE id = $1",
      [body.id],
    );
    assert.ok(rows[0]?.created_by);
  });

  it("creates a bond quoted in percent of nominal with a price factor of 0.01 (priceFactorE6 10000)", async () => {
    const created = await post(tokenA, {
      isin: randomIsin(),
      name: `${namePrefix} Government bond`,
      type: "government_bond",
      currency: "EUR",
      priceFactorE6: 10_000,
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().priceFactorE6, 10_000);
    const read = await get(tokenA, `/instruments/${created.json().id}`);
    assert.equal(read.json().priceFactorE6, 10_000);
  });

  it("rejects a zero, negative or non-integer price factor with invalid_price_factor", async () => {
    for (const priceFactorE6 of [0, -1, -10_000, 0.5, "10000"]) {
      const response = await post(tokenA, {
        isin: randomIsin(),
        name: `${namePrefix} Bad factor`,
        type: "bond",
        currency: "EUR",
        priceFactorE6,
      });
      assert.equal(response.statusCode, 400, String(priceFactorE6));
      assert.equal(response.json().error, "invalid_price_factor");
    }
  });

  it("accepts every instrument type", async () => {
    for (const type of ["stock", "fund", "etc_etn", "government_bond", "bond", "certificate", "cash", "other"]) {
      const response = await post(tokenA, { isin: randomIsin(), name: `${namePrefix} Type ${type}`, type, currency: "EUR" });
      assert.equal(response.statusCode, 201, type);
      assert.equal(response.json().type, type);
    }
  });

  it("rejects a field that is present but not a string with invalid_instrument_field", async () => {
    const base = { isin: randomIsin(), name: `${namePrefix} Typed`, type: "fund", currency: "EUR" };
    const cases: [string, unknown][] = [
      ["isin", 123],
      ["ticker", ["ABC"]],
      ["exchange", { mic: "XMIL" }],
      ["name", 42],
      ["name", null],
      ["type", true],
      ["currency", 978],
      ["assetClass", 1],
    ];
    for (const [field, value] of cases) {
      const response = await post(tokenA, { ...base, [field]: value });
      assert.equal(response.statusCode, 400, `${field}: ${JSON.stringify(value)}`);
      assert.deepEqual(response.json(), { error: "invalid_instrument_field", details: { field } }, field);
    }
  });

  it("checks a ticker after upper-casing, so a lengthening one is a 400, never a 500", async () => {
    const response = await post(tokenA, {
      ticker: "\u00df".repeat(20),
      exchange: "XMIL",
      name: `${namePrefix} Long ticker`,
      type: "stock",
      currency: "EUR",
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_ticker");
  });

  it("strips control and format characters from the name", async () => {
    const response = await post(tokenA, {
      isin: randomIsin(),
      name: `${namePrefix} Hid\u200bden\u0007`,
      type: "fund",
      currency: "EUR",
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().name, `${namePrefix} Hidden`);
  });

  it("rejects invalid input with stable codes", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: `${namePrefix} No id`, type: "cash", currency: "EUR" }, "missing_instrument_identifier"],
      [{ ticker: randomTicker(), name: `${namePrefix} No exchange`, type: "stock", currency: "USD" }, "missing_exchange"],
      [{ isin: "US0378331004", name: `${namePrefix} Bad ISIN`, type: "stock", currency: "USD" }, "invalid_isin"],
      [{ isin: randomIsin(), name: `${namePrefix} Bad type`, type: "crypto", currency: "USD" }, "invalid_instrument_type"],
      [{ isin: randomIsin(), name: `${namePrefix} Old type`, type: "etf", currency: "USD" }, "invalid_instrument_type"],
      [{ isin: randomIsin(), name: `${namePrefix} Bad currency`, type: "stock", currency: "EURO" }, "invalid_currency"],
      [{ isin: randomIsin(), name: "  ", type: "stock", currency: "USD" }, "invalid_instrument_field"],
      [{ isin: randomIsin(), exchange: "MIL", name: `${namePrefix} Short MIC`, type: "stock", currency: "EUR" }, "invalid_exchange"],
      [{ isin: randomIsin(), exchange: "XMIL\u200b", name: `${namePrefix} Hidden MIC`, type: "stock", currency: "EUR" }, "invalid_exchange"],
      [{ ticker: "AB C", exchange: "XMIL", name: `${namePrefix} Spaced ticker`, type: "stock", currency: "EUR" }, "invalid_ticker"],
    ];
    for (const [payload, code] of cases) {
      const response = await post(tokenA, payload);
      assert.equal(response.statusCode, 400, code);
      assert.equal(response.json().error, code);
    }
  });

  it("rejects the same ISIN on the same exchange, but accepts it on another exchange", async () => {
    const isin = randomIsin();
    const base = { isin, name: `${namePrefix} Listed twice`, type: "fund", currency: "EUR" };
    assert.equal((await post(tokenA, { ...base, exchange: "XMIL" })).statusCode, 201);

    const duplicate = await post(tokenB, { ...base, exchange: "xmil" });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().code, "isin_taken");

    const otherExchange = await post(tokenA, { ...base, exchange: "XETR", currency: "USD" });
    assert.equal(otherExchange.statusCode, 201);
  });

  it("rejects the same ISIN twice when neither names an exchange", async () => {
    const base = { isin: randomIsin(), name: `${namePrefix} Fund`, type: "fund", currency: "EUR" };
    assert.equal((await post(tokenA, base)).statusCode, 201);
    const duplicate = await post(tokenA, base);
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().code, "isin_taken");
  });

  it("rejects the same ticker on the same exchange, ignoring case", async () => {
    const ticker = randomTicker();
    const first = await post(tokenA, { ticker, exchange: "XNAS", name: `${namePrefix} Ticker`, type: "stock", currency: "USD" });
    assert.equal(first.statusCode, 201);

    const duplicate = await post(tokenB, {
      ticker: ticker.toLowerCase(),
      exchange: "xnas",
      name: `${namePrefix} Ticker again`,
      type: "stock",
      currency: "USD",
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().code, "ticker_taken");

    const otherExchange = await post(tokenA, {
      ticker,
      exchange: "XNYS",
      name: `${namePrefix} Ticker elsewhere`,
      type: "stock",
      currency: "USD",
    });
    assert.equal(otherExchange.statusCode, 201);
  });

  it("lets a user of another workspace find an instrument by ISIN, ticker prefix or name prefix", async () => {
    const isin = randomIsin();
    const ticker = randomTicker();
    const created = await post(tokenA, {
      isin,
      ticker,
      exchange: "XAMS",
      name: `${namePrefix} Shared find`,
      type: "stock",
      currency: "EUR",
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;

    const byIsin = await get(tokenB, `/instruments?q=${isin.toLowerCase()}`);
    assert.equal(byIsin.statusCode, 200);
    assert.deepEqual(
      byIsin.json().instruments.map((instrument: { id: string }) => instrument.id),
      [id],
    );

    const byTicker = await get(tokenB, `/instruments?q=${ticker.slice(0, 8).toLowerCase()}`);
    assert.equal(byTicker.statusCode, 200);
    assert.ok(byTicker.json().instruments.some((instrument: { id: string }) => instrument.id === id));

    const byName = await get(tokenB, `/instruments?q=${encodeURIComponent(`${namePrefix} shared`)}`);
    assert.equal(byName.statusCode, 200);
    assert.deepEqual(
      byName.json().instruments.map((instrument: { id: string }) => instrument.id),
      [id],
    );
    for (const instrument of byName.json().instruments) {
      assert.equal("createdBy" in instrument, false);
    }

    const byId = await get(tokenB, `/instruments/${id}`);
    assert.equal(byId.statusCode, 200);
  });

  it("never lists the whole catalog: a search needs an ISIN or a prefix of at least 2 characters", async () => {
    for (const url of ["/instruments", "/instruments?q=", "/instruments?q=%20%20", "/instruments?q=a"]) {
      const response = await get(tokenA, url);
      assert.equal(response.statusCode, 400, url);
      assert.equal(response.json().error, "search_query_too_short");
      assert.equal(response.json().details.minLength, 2);
    }
  });

  it("returns at most 20 results", async () => {
    const values: string[] = [];
    const params: string[] = [];
    for (let i = 0; i < 25; i++) {
      params.push(randomIsin(), `${namePrefix} Many ${String(i).padStart(2, "0")}`);
      values.push(`($${params.length - 1}, $${params.length}, 'fund', 'EUR')`);
    }
    await superuserPool.query(`INSERT INTO instruments (isin, name, type, currency) VALUES ${values.join(", ")}`, params);

    const response = await get(tokenA, `/instruments?q=${encodeURIComponent(`${namePrefix} Many`)}`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().instruments.length, 20);
  });

  it("treats LIKE wildcards and the escape character in the query as plain characters", async () => {
    // For each special character, one row has it literally and one has an ordinary character in
    // its place: only the literal one may match.
    for (const special of ["%", "_", "\\"]) {
      const literal = await post(tokenA, {
        isin: randomIsin(),
        name: `${namePrefix}${special}lit`,
        type: "fund",
        currency: "EUR",
      });
      const ordinary = await post(tokenA, { isin: randomIsin(), name: `${namePrefix}zlit`, type: "fund", currency: "EUR" });
      assert.equal(literal.statusCode, 201, special);
      assert.equal(ordinary.statusCode, 201, special);

      const response = await get(tokenA, `/instruments?q=${encodeURIComponent(`${namePrefix}${special}`)}`);
      assert.equal(response.statusCode, 200, special);
      assert.deepEqual(
        response.json().instruments.map((instrument: { id: string }) => instrument.id),
        [literal.json().id],
        special,
      );

      await superuserPool.query("DELETE FROM instruments WHERE id = ANY($1)", [[literal.json().id, ordinary.json().id]]);
    }
  });

  it("lets only one of two identical concurrent requests through", async () => {
    const payload = { isin: randomIsin(), exchange: "XETR", name: `${namePrefix} Race`, type: "fund", currency: "EUR" };
    const responses = await Promise.all([post(tokenA, payload), post(tokenB, payload)]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
    const conflict = responses.find((response) => response.statusCode === 409)!;
    assert.equal(conflict.json().code, "isin_taken");
  });

  it("answers 404 for an unknown or malformed id", async () => {
    assert.equal((await get(tokenA, `/instruments/${randomUUID()}`)).statusCode, 404);
    assert.equal((await get(tokenA, "/instruments/not-a-uuid")).statusCode, 404);
  });

  it("has no endpoint that updates or deletes an instrument", async () => {
    // A fresh token, so the 404s below never depend on how long the suite's shared one has
    // already lived (the test realm's tokens live a minute, `keycloak.ts`).
    const token = await ctx.realm.getUserToken();
    const created = await post(token, { isin: randomIsin(), name: `${namePrefix} Fixed`, type: "fund", currency: "EUR" });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;
    for (const method of ["PATCH", "PUT", "DELETE"] as const) {
      const response = await app.fastify.inject({
        method,
        url: `/instruments/${id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "Changed" },
      });
      assert.equal(response.statusCode, 404, method);
    }
    const { rows } = await superuserPool.query<{ name: string }>("SELECT name FROM instruments WHERE id = $1", [id]);
    assert.deepEqual(rows, [{ name: `${namePrefix} Fixed` }]);
  });

  it("gives envelope_app SELECT and INSERT on instruments, and no UPDATE or DELETE", async () => {
    const inserted = await appRolePool.query<{ id: string }>(
      "INSERT INTO instruments (isin, name, type, currency) VALUES ($1, $2, 'fund', 'EUR') RETURNING id",
      [randomIsin(), `${namePrefix} App role`],
    );
    const id = inserted.rows[0]!.id;
    const selected = await appRolePool.query("SELECT id FROM instruments WHERE id = $1", [id]);
    assert.equal(selected.rowCount, 1);

    await assert.rejects(appRolePool.query("UPDATE instruments SET name = 'Changed' WHERE id = $1", [id]), {
      code: "42501",
    });
    await assert.rejects(appRolePool.query("DELETE FROM instruments WHERE id = $1", [id]), { code: "42501" });
  });

  it("enforces the identifier rule in the table too", async () => {
    await assert.rejects(
      superuserPool.query("INSERT INTO instruments (name, type, currency) VALUES ($1, 'cash', 'EUR')", [`${namePrefix} No id`]),
      { code: "23514", constraint: "instruments_identifier_check" },
    );
    await assert.rejects(
      superuserPool.query("INSERT INTO instruments (ticker, name, type, currency) VALUES ('ABC', $1, 'stock', 'USD')", [
        `${namePrefix} No exchange`,
      ]),
      { code: "23514", constraint: "instruments_ticker_exchange_check" },
    );
    await assert.rejects(
      superuserPool.query("INSERT INTO instruments (ticker, exchange, name, type, currency) VALUES ('ABC', 'MIL', $1, 'stock', 'EUR')", [
        `${namePrefix} Short MIC`,
      ]),
      { code: "23514", constraint: "instruments_exchange_check" },
    );
    await assert.rejects(
      superuserPool.query("INSERT INTO instruments (ticker, exchange, name, type, currency) VALUES ('abc', 'XMIL', $1, 'stock', 'EUR')", [
        `${namePrefix} Lower ticker`,
      ]),
      { code: "23514", constraint: "instruments_ticker_check" },
    );
  });

  describe("a workspace's private instruments (#505)", () => {
    function postPrivate(token: string, workspaceId: string, payload: Record<string, unknown>) {
      return app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/instruments`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    }

    async function addMembership(token: string, workspaceId: string, role: "owner" | "editor" | "read_only"): Promise<void> {
      const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [decodeJwt(token).sub]);
      await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [rows[0]!.id, workspaceId, role]);
    }

    it("creates one with only a name, a type, a currency and an asset class, and finds it in its own workspace only", async () => {
      const token = await ctx.realm.getUserToken();
      const created = await postPrivate(token, ctx.workspaceId, {
        name: `${namePrefix} Flat in town`,
        type: "other",
        currency: "eur",
        assetClass: "Real estate",
      });
      assert.equal(created.statusCode, 201, created.body);
      const body = created.json();
      assert.deepEqual(
        { ...body, id: undefined },
        {
          id: undefined,
          workspaceId: ctx.workspaceId,
          isin: null,
          ticker: null,
          exchange: null,
          name: `${namePrefix} Flat in town`,
          type: "other",
          currency: "EUR",
          assetClass: "Real estate",
          priceFactorE6: 1_000_000,
        },
      );

      // Its own workspace lists it and reads it.
      const listed = await get(token, `/workspaces/${ctx.workspaceId}/instruments`);
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(
        listed.json().instruments.map((instrument: { id: string }) => instrument.id),
        [body.id],
      );
      const read = await get(token, `/workspaces/${ctx.workspaceId}/instruments/${body.id}`);
      assert.equal(read.statusCode, 200);
      assert.deepEqual(read.json(), body);

      // Another workspace neither lists nor reads it, knowing its id.
      const tokenOfB = tokenB;
      const listedByB = await get(tokenOfB, `/workspaces/${workspaceB}/instruments`);
      assert.equal(listedByB.statusCode, 200);
      assert.deepEqual(listedByB.json().instruments, []);
      assert.equal((await get(tokenOfB, `/workspaces/${workspaceB}/instruments/${body.id}`)).statusCode, 404);
      assert.equal((await get(tokenOfB, `/workspaces/${ctx.workspaceId}/instruments`)).statusCode, 403);

      // The /instruments routes have no workspace: they see the shared catalog only, even for
      // the user whose workspace owns the instrument.
      for (const userToken of [token, tokenOfB]) {
        assert.equal((await get(userToken, `/instruments/${body.id}`)).statusCode, 404);
        const searched = await get(userToken, `/instruments?q=${encodeURIComponent(`${namePrefix} Flat`)}`);
        assert.equal(searched.statusCode, 200);
        assert.deepEqual(searched.json().instruments, []);
      }
    });

    it("reads a shared instrument through the workspace too, and answers 404 for an unknown or malformed id", async () => {
      const token = await ctx.realm.getUserToken();
      const sharedOne = await post(token, { isin: randomIsin(), name: `${namePrefix} Shared bond`, type: "bond", currency: "EUR" });
      assert.equal(sharedOne.statusCode, 201);
      const read = await get(token, `/workspaces/${ctx.workspaceId}/instruments/${sharedOne.json().id}`);
      assert.equal(read.statusCode, 200);
      assert.equal(read.json().workspaceId, null);
      assert.equal((await get(token, `/workspaces/${ctx.workspaceId}/instruments/${randomUUID()}`)).statusCode, 404);
      assert.equal((await get(token, `/workspaces/${ctx.workspaceId}/instruments/not-a-uuid`)).statusCode, 404);
      // The workspace's list holds its private instruments, never the shared catalog.
      const listed = await get(token, `/workspaces/${ctx.workspaceId}/instruments`);
      assert.ok(listed.json().instruments.every((instrument: { workspaceId: string | null }) => instrument.workspaceId === ctx.workspaceId));
    });

    it("refuses an ISIN, a ticker or an exchange, and invalid fields, with stable codes", async () => {
      const token = await ctx.realm.getUserToken();
      const base = { name: `${namePrefix} Pension fund`, type: "fund", currency: "EUR" };
      for (const [field, value] of [
        ["isin", randomIsin()],
        ["ticker", "FLAT"],
        ["exchange", "XMIL"],
        ["isin", ""],
        ["ticker", 12],
      ] as const) {
        const response = await postPrivate(token, ctx.workspaceId, { ...base, [field]: value });
        assert.equal(response.statusCode, 400, `${field}: ${response.body}`);
        assert.deepEqual(response.json(), { error: "invalid_instrument_field", details: { field } });
      }
      // null is the same as leaving an identifier out.
      const withNulls = await postPrivate(token, ctx.workspaceId, { ...base, isin: null, ticker: null, exchange: null });
      assert.equal(withNulls.statusCode, 201, withNulls.body);

      for (const [payload, code] of [
        [{ ...base, name: " " }, "invalid_instrument_field"],
        [{ ...base, name: undefined }, "invalid_instrument_field"],
        [{ ...base, type: "house" }, "invalid_instrument_type"],
        [{ ...base, currency: "EURO" }, "invalid_currency"],
        [{ ...base, assetClass: 3 }, "invalid_instrument_field"],
        [{ ...base, priceFactorE6: 0 }, "invalid_price_factor"],
      ] as const) {
        const response = await postPrivate(token, ctx.workspaceId, payload);
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
        assert.equal(response.json().error, code, JSON.stringify(payload));
      }
    });

    it("lets owners and editors add one, every member list them, and nobody outside the workspace either", async () => {
      const token = await ctx.realm.getUserToken();
      const payload = { name: `${namePrefix} Company shares`, type: "stock", currency: "EUR" };
      for (const role of ["editor", "read_only"] as const) {
        const workspaceId = randomUUID();
        await superuserPool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Role test', 'EUR', 'Europe/Rome')", [
          workspaceId,
        ]);
        try {
          await addMembership(token, workspaceId, role);
          const response = await postPrivate(token, workspaceId, payload);
          assert.equal(response.statusCode, role === "editor" ? 201 : 403, `${role}: ${response.body}`);
          const listed = await get(token, `/workspaces/${workspaceId}/instruments`);
          assert.equal(listed.statusCode, 200);
          assert.equal(listed.json().instruments.length, role === "editor" ? 1 : 0);
        } finally {
          await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
        }
      }
      // Not a member: 403, and nothing written.
      const outsider = await postPrivate(tokenB, ctx.workspaceId, payload);
      assert.equal(outsider.statusCode, 403);
      assert.equal((await post(undefined, payload)).statusCode, 401);
      assert.equal(
        (await app.fastify.inject({ method: "POST", url: `/workspaces/${ctx.workspaceId}/instruments`, payload })).statusCode,
        401,
      );
      const { rows } = await superuserPool.query("SELECT 1 FROM instruments WHERE name = $1", [payload.name]);
      assert.deepEqual(rows, []);
    });

    it("refuses a second private instrument with the same name in one workspace, whatever its case or spaces, as name_taken", async () => {
      const token = await ctx.realm.getUserToken();
      const name = `${namePrefix} Holiday home`;
      const first = await postPrivate(token, ctx.workspaceId, { name, type: "other", currency: "EUR" });
      assert.equal(first.statusCode, 201, first.body);
      for (const duplicateName of [name, name.toUpperCase(), `  ${name.toLowerCase()}  `]) {
        const duplicate = await postPrivate(token, ctx.workspaceId, { name: duplicateName, type: "fund", currency: "USD" });
        assert.equal(duplicate.statusCode, 409, duplicateName);
        assert.equal(duplicate.json().code, "name_taken");
      }
      const { rows } = await superuserPool.query("SELECT 1 FROM instruments WHERE workspace_id = $1 AND lower(name) = lower($2)", [
        ctx.workspaceId,
        name,
      ]);
      assert.equal(rows.length, 1);

      // Another workspace may use the same name: the names of one workspace are never compared
      // with another's, so the answer tells it nothing.
      const inB = await postPrivate(tokenB, workspaceB, { name, type: "other", currency: "EUR" });
      assert.equal(inB.statusCode, 201, inB.body);
    });

    it("accepts a private instrument named like a shared one", async () => {
      const token = await ctx.realm.getUserToken();
      const name = `${namePrefix} Listed and private`;
      const sharedOne = await post(token, { isin: randomIsin(), name, type: "stock", currency: "EUR" });
      assert.equal(sharedOne.statusCode, 201, sharedOne.body);
      const privateOne = await postPrivate(token, ctx.workspaceId, { name, type: "stock", currency: "EUR" });
      assert.equal(privateOne.statusCode, 201, privateOne.body);
    });

    it("has no endpoint that updates or deletes a private instrument", async () => {
      const token = await ctx.realm.getUserToken();
      const created = await postPrivate(token, ctx.workspaceId, { name: `${namePrefix} Fixed flat`, type: "other", currency: "EUR" });
      assert.equal(created.statusCode, 201);
      for (const method of ["PATCH", "PUT", "DELETE"] as const) {
        const response = await app.fastify.inject({
          method,
          url: `/workspaces/${ctx.workspaceId}/instruments/${created.json().id}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: "Changed" },
        });
        assert.equal(response.statusCode, 404, method);
      }
    });
  });
});
