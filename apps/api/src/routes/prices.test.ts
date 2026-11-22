import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { MAX_PRICE_CSV_ROWS } from "@envelope/core";
import { decodeJwt } from "jose";

import { type App } from "../app.ts";
import type { DbPool } from "../db/pool.ts";
import {
  requireIntegrationTestEnv,
  setupIntegrationTest,
  teardownIntegrationTest,
  type IntegrationTestContext,
} from "../test-helpers/integration-setup.ts";

requireIntegrationTestEnv();

type Role = "owner" | "editor" | "read_only";

describe("prices routes (#83)", () => {
  let ctx: IntegrationTestContext;
  let app: App;
  let superuserPool: DbPool;
  let workspaceA: string;
  let userA: string;
  let tokenA: string;
  let tokenB: string;
  let workspaceB: string;
  // Every instrument this file creates is named with this prefix, so `after` can remove them.
  const namePrefix = `Prices${randomUUID().slice(0, 8)}`;

  before(async () => {
    ctx = await setupIntegrationTest({ workspaceName: "Workspace A" });
    ({ app, superuserPool, token: tokenA, workspaceId: workspaceA } = ctx);
    const { rows: usersA } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      decodeJwt(tokenA).sub,
    ]);
    userA = usersA[0]!.id;

    tokenB = await ctx.realm.getTokenForNewUser();
    await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${tokenB}` } });
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [decodeJwt(tokenB).sub]);
    workspaceB = randomUUID();
    await superuserPool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Workspace B', 'EUR', 'Europe/Rome')", [
      workspaceB,
    ]);
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [rows[0]!.id, workspaceB]);
  });

  after(async () => {
    await superuserPool.query("DELETE FROM prices WHERE instrument_id IN (SELECT id FROM instruments WHERE name LIKE $1)", [`${namePrefix}%`]);
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceB]);
    await superuserPool.query("DELETE FROM instruments WHERE name LIKE $1", [`${namePrefix}%`]);
    await teardownIntegrationTest(ctx);
  });

  beforeEach(async () => {
    await setRole("owner");
    await superuserPool.query("UPDATE workspaces SET time_zone = 'Europe/Rome' WHERE id = $1", [workspaceA]);
  });

  async function setRole(role: Role): Promise<void> {
    await superuserPool.query("UPDATE memberships SET role = $1 WHERE user_id = $2 AND workspace_id = $3", [role, userA, workspaceA]);
  }

  async function sharedInstrument(): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO instruments (ticker, exchange, name, type, currency) VALUES ($1, 'XMIL', $2, 'fund', 'EUR') RETURNING id",
      [`P${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`, `${namePrefix} shared ${randomUUID()}`],
    );
    return rows[0]!.id;
  }

  async function privateInstrument(workspaceId: string): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO instruments (workspace_id, name, type, currency) VALUES ($1, $2, 'other', 'EUR') RETURNING id",
      [workspaceId, `${namePrefix} private ${randomUUID()}`],
    );
    return rows[0]!.id;
  }

  async function sharedPrice(instrumentId: string, date: string, closeE6: number): Promise<void> {
    await superuserPool.query(
      "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source, provider) VALUES (NULL, $1, $2, $3, 'provider', 'test')",
      [instrumentId, date, closeE6],
    );
  }

  /** Today and tomorrow in the workspace's time zone, read in one statement. */
  async function todayAndTomorrow(workspaceId = workspaceA): Promise<{ today: string; tomorrow: string }> {
    const { rows } = await superuserPool.query<{ today: string; tomorrow: string }>(
      `SELECT to_char(now() AT TIME ZONE time_zone, 'YYYY-MM-DD') AS today,
              to_char(now() AT TIME ZONE time_zone + interval '1 day', 'YYYY-MM-DD') AS tomorrow
       FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    return rows[0]!;
  }

  async function auditEntries(instrumentId: string): Promise<{ action: string; before: unknown; after: unknown }[]> {
    const { rows } = await superuserPool.query<{ action: string; before: unknown; after: unknown }>(
      "SELECT action, before, after FROM audit_log WHERE workspace_id = $1 AND (after->>'instrumentId' = $2 OR before->>'instrumentId' = $2) ORDER BY created_at, id",
      [workspaceA, instrumentId],
    );
    return rows;
  }

  async function storedOwn(instrumentId: string, workspaceId = workspaceA): Promise<{ price_date: string; close_e6: string; source: string }[]> {
    const { rows } = await superuserPool.query<{ price_date: string; close_e6: string; source: string }>(
      `SELECT to_char(price_date, 'YYYY-MM-DD') AS price_date, close_e6, source FROM prices
       WHERE workspace_id = $1 AND instrument_id = $2 ORDER BY price_date`,
      [workspaceId, instrumentId],
    );
    return rows;
  }

  function url(instrumentId: string, rest = "", workspaceId = workspaceA): string {
    return `/workspaces/${workspaceId}/instruments/${instrumentId}/prices${rest}`;
  }

  function get(path: string, token = tokenA) {
    return app.fastify.inject({ method: "GET", url: path, headers: { authorization: `Bearer ${token}` } });
  }

  function put(path: string, payload: unknown, token = tokenA) {
    return app.fastify.inject({
      method: "PUT",
      url: path,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
  }

  function del(path: string, token = tokenA) {
    return app.fastify.inject({ method: "DELETE", url: path, headers: { authorization: `Bearer ${token}` } });
  }

  function importCsv(path: string, csv: string, token = tokenA, contentType = "text/csv; charset=utf-8") {
    return app.fastify.inject({
      method: "POST",
      url: path,
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      payload: csv,
    });
  }

  describe("PUT a price", () => {
    it("creates a price (201), leaves the same close alone (200), replaces another close (200), one audit entry per change", async () => {
      const instrumentId = await sharedInstrument();
      const created = await put(url(instrumentId, "/2026-03-31"), { closeE6: 101_500000 });
      assert.equal(created.statusCode, 201);
      assert.deepEqual(created.json(), { priceDate: "2026-03-31", closeE6: 101_500000, source: "manual", origin: "own" });

      const same = await put(url(instrumentId, "/2026-03-31"), { closeE6: 101_500000 });
      assert.equal(same.statusCode, 200);
      assert.deepEqual(same.json(), created.json());

      const replaced = await put(url(instrumentId, "/2026-03-31"), { closeE6: 102_000000 });
      assert.equal(replaced.statusCode, 200);
      assert.equal(replaced.json().closeE6, 102_000000);

      assert.deepEqual(await storedOwn(instrumentId), [{ price_date: "2026-03-31", close_e6: "102000000", source: "manual" }]);
      const entries = await auditEntries(instrumentId);
      assert.deepEqual(
        entries.map((entry) => entry.action),
        ["price.create", "price.update"],
      );
      assert.deepEqual(entries[1], {
        action: "price.update",
        before: { instrumentId, priceDate: "2026-03-31", closeE6: 101_500000, source: "manual" },
        after: { instrumentId, priceDate: "2026-03-31", closeE6: 102_000000, source: "manual" },
      });
    });

    it("accepts a close of zero and the largest safe integer", async () => {
      const instrumentId = await sharedInstrument();
      assert.equal((await put(url(instrumentId, "/2026-03-30"), { closeE6: 0 })).statusCode, 201);
      assert.equal((await put(url(instrumentId, "/2026-03-31"), { closeE6: Number.MAX_SAFE_INTEGER })).statusCode, 201);
    });

    it("refuses a close that is not a non-negative safe integer with invalid_price, and writes nothing", async () => {
      const instrumentId = await sharedInstrument();
      for (const body of [{ closeE6: -1 }, { closeE6: 1.5 }, { closeE6: "100" }, { closeE6: null }, {}, { closeE6: 2 ** 53 }]) {
        const response = await put(url(instrumentId, "/2026-03-31"), body);
        assert.equal(response.statusCode, 400, JSON.stringify(body));
        assert.equal(response.json().error, "invalid_price", JSON.stringify(body));
      }
      assert.deepEqual(await storedOwn(instrumentId), []);
    });

    it("refuses an unknown field and a body that is not an object", async () => {
      const instrumentId = await sharedInstrument();
      const unknown = await put(url(instrumentId, "/2026-03-31"), { closeE6: 1, source: "provider" });
      assert.equal(unknown.statusCode, 400);
      assert.deepEqual(unknown.json(), { error: "unknown_field", details: { field: "source" } });
      const array = await put(url(instrumentId, "/2026-03-31"), [1]);
      assert.equal(array.json().error, "invalid_body");
    });

    it("refuses a malformed date with invalid_date naming the field", async () => {
      const instrumentId = await sharedInstrument();
      for (const date of ["2026-02-30", "31-03-2026", "today"]) {
        const response = await put(url(instrumentId, `/${date}`), { closeE6: 1 });
        assert.equal(response.statusCode, 400, date);
        assert.deepEqual(response.json(), { error: "invalid_date", details: { field: "date" } }, date);
      }
    });

    it("has no lower date limit: a price dated 1850 is accepted", async () => {
      const instrumentId = await sharedInstrument();
      const response = await put(url(instrumentId, "/1850-01-01"), { closeE6: 1_500000 });
      assert.equal(response.statusCode, 201);
      assert.deepEqual(await storedOwn(instrumentId), [{ price_date: "1850-01-01", close_e6: "1500000", source: "manual" }]);
    });

    it("accepts today and refuses tomorrow in the workspace's time zone, also where today is ahead of UTC", async () => {
      for (const timeZone of ["Europe/Rome", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
        await superuserPool.query("UPDATE workspaces SET time_zone = $1 WHERE id = $2", [timeZone, workspaceA]);
        const instrumentId = await sharedInstrument();
        const { today, tomorrow } = await todayAndTomorrow();
        assert.equal((await put(url(instrumentId, `/${today}`), { closeE6: 1 })).statusCode, 201, timeZone);
        const future = await put(url(instrumentId, `/${tomorrow}`), { closeE6: 1 });
        assert.equal(future.statusCode, 400, timeZone);
        assert.deepEqual(future.json(), { error: "invalid_date", details: { field: "date", max: today } }, timeZone);
      }
    });

    it("checks the instrument before the date and the body", async () => {
      const response = await put(url(randomUUID(), "/2999-01-01"), { closeE6: -1 });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: "instrument not found" });
    });
  });

  describe("GET prices", () => {
    it("lists own and shared prices by date, each with its origin, within from and to", async () => {
      const instrumentId = await sharedInstrument();
      await sharedPrice(instrumentId, "2026-03-27", 100_000000);
      await sharedPrice(instrumentId, "2026-03-30", 101_000000);
      assert.equal((await put(url(instrumentId, "/2026-03-30"), { closeE6: 99_000000 })).statusCode, 201);
      assert.equal((await put(url(instrumentId, "/2026-03-31"), { closeE6: 98_000000 })).statusCode, 201);

      const all = await get(url(instrumentId));
      assert.equal(all.statusCode, 200);
      assert.deepEqual(all.json().prices, [
        { priceDate: "2026-03-27", closeE6: 100_000000, source: "provider", origin: "shared" },
        { priceDate: "2026-03-30", closeE6: 101_000000, source: "provider", origin: "shared" },
        { priceDate: "2026-03-30", closeE6: 99_000000, source: "manual", origin: "own" },
        { priceDate: "2026-03-31", closeE6: 98_000000, source: "manual", origin: "own" },
      ]);

      const window = await get(url(instrumentId, "?from=2026-03-28&to=2026-03-30"));
      assert.deepEqual(
        window.json().prices.map((price: { priceDate: string; origin: string }) => `${price.priceDate} ${price.origin}`),
        ["2026-03-30 shared", "2026-03-30 own"],
      );
      assert.deepEqual((await get(url(instrumentId, "?from=2026-03-31&to=2026-03-31"))).json().prices.length, 1);
    });

    it("refuses a malformed or repeated from or to, and a to before from, with invalid_date naming it", async () => {
      const instrumentId = await sharedInstrument();
      const malformed = await get(url(instrumentId, "?from=2026-13-01"));
      assert.equal(malformed.statusCode, 400);
      assert.deepEqual(malformed.json(), { error: "invalid_date", details: { field: "from", value: "2026-13-01" } });
      const repeated = await get(url(instrumentId, "?to=2026-01-01&to=2026-02-01"));
      assert.equal(repeated.statusCode, 400);
      assert.deepEqual(repeated.json(), { error: "invalid_date", details: { field: "to" } });
      const backwards = await get(url(instrumentId, "?from=2026-04-01&to=2026-03-01"));
      assert.equal(backwards.statusCode, 400);
      assert.deepEqual(backwards.json(), { error: "invalid_date", details: { field: "to", value: "2026-03-01" } });
    });
  });

  describe("DELETE a price", () => {
    it("removes the own price (204, one audit entry), and answers 404 price not found when there is none", async () => {
      const instrumentId = await sharedInstrument();
      await put(url(instrumentId, "/2026-03-31"), { closeE6: 5_000000 });
      const removed = await del(url(instrumentId, "/2026-03-31"));
      assert.equal(removed.statusCode, 204);
      assert.deepEqual(await storedOwn(instrumentId), []);
      const entries = await auditEntries(instrumentId);
      assert.deepEqual(entries.at(-1), {
        action: "price.delete",
        before: { instrumentId, priceDate: "2026-03-31", closeE6: 5_000000, source: "manual" },
        after: null,
      });

      const again = await del(url(instrumentId, "/2026-03-31"));
      assert.equal(again.statusCode, 404);
      assert.deepEqual(again.json(), { error: "price not found" });
      assert.equal((await auditEntries(instrumentId)).length, entries.length);
    });

    it("never deletes a shared price: a date with only a shared price is price not found", async () => {
      const instrumentId = await sharedInstrument();
      await sharedPrice(instrumentId, "2026-03-31", 7_000000);
      const response = await del(url(instrumentId, "/2026-03-31"));
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: "price not found" });
      assert.equal((await get(url(instrumentId))).json().prices.length, 1);
    });

    it("refuses a malformed date with invalid_date naming the field, as PUT does", async () => {
      const instrumentId = await sharedInstrument();
      for (const date of ["2026-02-30", "31-03-2026", "today"]) {
        const response = await del(url(instrumentId, `/${date}`));
        assert.equal(response.statusCode, 400, date);
        assert.deepEqual(response.json(), { error: "invalid_date", details: { field: "date" } }, date);
      }
    });
  });

  describe("POST a price file", () => {
    it("imports every row, reports the counts, and writes one summary audit entry", async () => {
      const instrumentId = await sharedInstrument();
      const response = await importCsv(url(instrumentId, "/import"), "date,close\n2026-03-31,101.5\n2026-03-27,100\n2026-03-30,\"1,000.25\"\n");
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { inserted: 3, replaced: 0, unchanged: 0, from: "2026-03-27", to: "2026-03-31" });
      assert.deepEqual(await storedOwn(instrumentId), [
        { price_date: "2026-03-27", close_e6: "100000000", source: "csv" },
        { price_date: "2026-03-30", close_e6: "1000250000", source: "csv" },
        { price_date: "2026-03-31", close_e6: "101500000", source: "csv" },
      ]);
      assert.deepEqual(await auditEntries(instrumentId), [
        {
          action: "price.import",
          before: null,
          after: { instrumentId, rows: 3, inserted: 3, replaced: 0, unchanged: 0, from: "2026-03-27", to: "2026-03-31" },
        },
      ]);
    });

    it("reports a re-import as unchanged and writes no audit entry; a changed close is replaced", async () => {
      const instrumentId = await sharedInstrument();
      const csv = "2026-03-30,10\n2026-03-31,11\n";
      assert.equal((await importCsv(url(instrumentId, "/import"), csv)).statusCode, 200);
      const again = await importCsv(url(instrumentId, "/import"), csv);
      assert.deepEqual(again.json(), { inserted: 0, replaced: 0, unchanged: 2, from: "2026-03-30", to: "2026-03-31" });
      assert.equal((await auditEntries(instrumentId)).length, 1);

      const changed = await importCsv(url(instrumentId, "/import"), "2026-03-30,10\n2026-03-31,12\n2026-04-01,13\n");
      assert.deepEqual(changed.json(), { inserted: 1, replaced: 1, unchanged: 1, from: "2026-03-30", to: "2026-04-01" });
      assert.equal((await auditEntries(instrumentId)).length, 2);
    });

    it("turns a manual price into a CSV one only when its close changes", async () => {
      const instrumentId = await sharedInstrument();
      await put(url(instrumentId, "/2026-03-30"), { closeE6: 10_000000 });
      await put(url(instrumentId, "/2026-03-31"), { closeE6: 10_000000 });
      await importCsv(url(instrumentId, "/import"), "2026-03-30,10\n2026-03-31,11\n");
      assert.deepEqual(
        (await storedOwn(instrumentId)).map((row) => row.source),
        ["manual", "csv"],
      );
    });

    it("reads the close in the locale given", async () => {
      const instrumentId = await sharedInstrument();
      const response = await importCsv(url(instrumentId, "/import?locale=it-IT"), '2026-03-31,"1.234,5"\n');
      assert.equal(response.statusCode, 200);
      assert.deepEqual(await storedOwn(instrumentId), [{ price_date: "2026-03-31", close_e6: "1234500000", source: "csv" }]);
    });

    it("refuses the whole file at the first bad line, naming it, and stores nothing", async () => {
      const instrumentId = await sharedInstrument();
      const { today, tomorrow } = await todayAndTomorrow();
      const cases: [string, Record<string, unknown>][] = [
        ["date,close\n2026-03-30,10\n2026-03-31,ten\n", { line: 3, column: 2, reason: "invalid_price_format" }],
        ["2026-03-30,10\n\n2026-02-30,10\n", { line: 3, column: 1, reason: "invalid_date" }],
        [`2026-03-30,10\n${tomorrow},10\n`, { line: 2, column: 1, reason: "invalid_date", max: today }],
        ["2026-03-30,10\n2026-03-30,11\n", { line: 2, column: 1, reason: "duplicate_date" }],
        ["2026-03-30,-10\n", { line: 1, column: 2, reason: "invalid_price" }],
        ["2026-03-30\n", { line: 1, column: 2, reason: "missing_column" }],
        ["2026-03-30,10,EUR\n", { line: 1, column: 3, reason: "extra_column" }],
        ["date,close\n", { line: 1, column: 1, reason: "no_rows" }],
      ];
      for (const [csv, details] of cases) {
        const response = await importCsv(url(instrumentId, "/import"), csv);
        assert.equal(response.statusCode, 400, csv);
        assert.deepEqual(response.json(), { error: "invalid_price_file", details }, csv);
      }
      assert.deepEqual(await storedOwn(instrumentId), []);
      assert.deepEqual(await auditEntries(instrumentId), []);
    });

    it("accepts a file dated today and refuses one dated tomorrow in the workspace's time zone, also where today is ahead of UTC", async () => {
      // Between them, the two zones put the local date on another day than UTC's at every hour.
      for (const timeZone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
        await superuserPool.query("UPDATE workspaces SET time_zone = $1 WHERE id = $2", [timeZone, workspaceA]);
        const instrumentId = await sharedInstrument();
        const { today, tomorrow } = await todayAndTomorrow();
        const accepted = await importCsv(url(instrumentId, "/import"), `date,close\n${today},10\n`);
        assert.equal(accepted.statusCode, 200, timeZone);
        assert.deepEqual(await storedOwn(instrumentId), [{ price_date: today, close_e6: "10000000", source: "csv" }], timeZone);
        const refused = await importCsv(url(instrumentId, "/import"), `date,close\n${tomorrow},10\n`);
        assert.equal(refused.statusCode, 400, timeZone);
        assert.deepEqual(
          refused.json(),
          { error: "invalid_price_file", details: { line: 2, column: 1, reason: "invalid_date", max: today } },
          timeZone,
        );
      }
    });

    it("has no lower date limit: a file dated 1850 imports", async () => {
      const instrumentId = await sharedInstrument();
      const response = await importCsv(url(instrumentId, "/import"), "1850-01-01,1.5\n1850-01-02,1.25\n");
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().inserted, 2);
      assert.deepEqual(
        (await storedOwn(instrumentId)).map((price) => price.price_date),
        ["1850-01-01", "1850-01-02"],
      );
    });

    it("refuses a file of more than the maximum number of rows with too_many_rows", async () => {
      const instrumentId = await sharedInstrument();
      const rows = Array.from({ length: MAX_PRICE_CSV_ROWS + 1 }, (_, index) => {
        const date = new Date(Date.UTC(1950, 0, 1 + index)).toISOString().slice(0, 10);
        return `${date},1`;
      });
      const response = await importCsv(url(instrumentId, "/import"), rows.join("\n"));
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "too_many_rows", details: { max: MAX_PRICE_CSV_ROWS } });
      assert.deepEqual(await storedOwn(instrumentId), []);
    });

    it("imports the maximum number of rows", async () => {
      const instrumentId = await sharedInstrument();
      const rows = Array.from({ length: MAX_PRICE_CSV_ROWS }, (_, index) => {
        const date = new Date(Date.UTC(1950, 0, 1 + index)).toISOString().slice(0, 10);
        return `${date},${index}.25`;
      });
      const response = await importCsv(url(instrumentId, "/import"), `date,close\n${rows.join("\n")}\n`);
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().inserted, MAX_PRICE_CSV_ROWS);
    });

    it("refuses a body that is not text/csv with 415, and a locale that is not one with invalid_locale", async () => {
      const instrumentId = await sharedInstrument();
      const asPlain = await importCsv(url(instrumentId, "/import"), "2026-03-30,10\n", tokenA, "text/plain");
      assert.equal(asPlain.statusCode, 415);
      const asJson = await importCsv(url(instrumentId, "/import"), JSON.stringify({ content: "2026-03-30,10" }), tokenA, "application/json");
      assert.equal(asJson.statusCode, 415);
      const badLocale = await importCsv(url(instrumentId, "/import?locale=%3F%3F"), "2026-03-30,10\n");
      assert.equal(badLocale.statusCode, 400);
      assert.deepEqual(badLocale.json(), { error: "invalid_locale", details: { value: "??" } });
      // Bounded, so that a client cannot fill the cache of separators per locale with tags of its own.
      const overLong = "en-US-abcdefgh-bcdefghi-cdefghij-defghijk"; // well-formed, 41 characters
      const privateUse = "en-x-a1b2c3d4";
      for (const value of [overLong, privateUse, "it-IT-u-nu-arab"]) {
        const response = await importCsv(url(instrumentId, `/import?locale=${encodeURIComponent(value)}`), "2026-03-30,10\n");
        assert.equal(response.statusCode, 400, value);
        assert.deepEqual(response.json(), { error: "invalid_locale", details: { value } }, value);
      }
      assert.deepEqual(await storedOwn(instrumentId), []);
    });

    it("refuses a text/csv body on any other route", async () => {
      const instrumentId = await sharedInstrument();
      const response = await app.fastify.inject({
        method: "PUT",
        url: url(instrumentId, "/2026-03-30"),
        headers: { authorization: `Bearer ${tokenA}`, "content-type": "text/csv" },
        payload: "closeE6\n1",
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "invalid_body");
      const elsewhere = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceA}/portfolios`,
        headers: { authorization: `Bearer ${tokenA}`, "content-type": "text/csv" },
        payload: "name\nx",
      });
      assert.equal(elsewhere.statusCode, 415);
    });
  });

  describe("roles", () => {
    it("lets every member read, owners and editors write, and refuses read_only members with 403", async () => {
      const instrumentId = await sharedInstrument();
      await put(url(instrumentId, "/2026-03-30"), { closeE6: 1 });

      await setRole("read_only");
      assert.equal((await get(url(instrumentId))).statusCode, 200);
      assert.equal((await put(url(instrumentId, "/2026-03-31"), { closeE6: 1 })).statusCode, 403);
      assert.equal((await del(url(instrumentId, "/2026-03-30"))).statusCode, 403);
      assert.equal((await importCsv(url(instrumentId, "/import"), "2026-03-31,1\n")).statusCode, 403);
      assert.deepEqual(
        (await storedOwn(instrumentId)).map((row) => row.price_date),
        ["2026-03-30"],
      );

      await setRole("editor");
      assert.equal((await put(url(instrumentId, "/2026-03-31"), { closeE6: 1 })).statusCode, 201);
      assert.equal((await del(url(instrumentId, "/2026-03-30"))).statusCode, 204);
      assert.equal((await importCsv(url(instrumentId, "/import"), "2026-03-29,1\n")).statusCode, 200);
    });

    it("refuses a workspace the caller is not a member of", async () => {
      const instrumentId = await sharedInstrument();
      assert.equal((await get(url(instrumentId, "", workspaceB))).statusCode, 403);
      assert.equal((await put(url(instrumentId, "/2026-03-31", workspaceB), { closeE6: 1 })).statusCode, 403);
    });
  });

  describe("private instruments and other workspaces", () => {
    it("prices the workspace's own private instrument", async () => {
      const instrumentId = await privateInstrument(workspaceA);
      assert.equal((await put(url(instrumentId, "/2026-03-30"), { closeE6: 250_000_000000 })).statusCode, 201);
      assert.equal((await importCsv(url(instrumentId, "/import"), "2026-03-31,251000\n")).statusCode, 200);
      assert.deepEqual(
        (await get(url(instrumentId))).json().prices.map((price: { closeE6: number }) => price.closeE6),
        [250_000_000000, 251_000_000000],
      );
    });

    it("answers 404 instrument not found for another workspace's private instrument, an unknown or a malformed id, and stores nothing", async () => {
      const ofB = await privateInstrument(workspaceB);
      // A malformed id is answered by the check every route's id parameters get (#512), with the same body.
      for (const instrumentId of [ofB, randomUUID(), "not-an-id"]) {
        for (const response of [
          await get(url(instrumentId)),
          await put(url(instrumentId, "/2026-03-31"), { closeE6: 1 }),
          await del(url(instrumentId, "/2026-03-31")),
          await importCsv(url(instrumentId, "/import"), "2026-03-31,1\n"),
        ]) {
          assert.equal(response.statusCode, 404, instrumentId);
          assert.deepEqual(response.json(), { error: "instrument not found" }, instrumentId);
        }
      }
      const { rows } = await superuserPool.query("SELECT 1 FROM prices WHERE instrument_id = $1", [ofB]);
      assert.equal(rows.length, 0);
    });

    it("never shows one workspace's prices to another, nor lets it delete them", async () => {
      const instrumentId = await sharedInstrument();
      await sharedPrice(instrumentId, "2026-03-27", 100_000000);
      await put(url(instrumentId, "/2026-03-30"), { closeE6: 99_000000 });

      const asB = await get(url(instrumentId, "", workspaceB), tokenB);
      assert.equal(asB.statusCode, 200);
      assert.deepEqual(asB.json().prices, [{ priceDate: "2026-03-27", closeE6: 100_000000, source: "provider", origin: "shared" }]);
      assert.equal((await del(url(instrumentId, "/2026-03-30", workspaceB), tokenB)).statusCode, 404);
      // B's own price on the same date is B's alone.
      assert.equal((await put(url(instrumentId, "/2026-03-30", workspaceB), { closeE6: 1 }, tokenB)).statusCode, 201);
      assert.deepEqual(await storedOwn(instrumentId), [{ price_date: "2026-03-30", close_e6: "99000000", source: "manual" }]);
      assert.deepEqual(await storedOwn(instrumentId, workspaceB), [{ price_date: "2026-03-30", close_e6: "1", source: "manual" }]);
    });
  });
});
