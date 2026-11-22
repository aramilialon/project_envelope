import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { isValidationError } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbClient, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { deleteWorkspacePrice, listPrices, loadPriceCandidates, upsertWorkspacePrices } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

describe("prices (#82), as the envelope_app role", () => {
  let superuserPool: DbPool;
  let appPool: DbPool;
  let instrumentId: string;
  let otherInstrumentId: string;
  let workspaceA: string;
  let workspaceB: string;
  let userA: string;
  /** Workspace B's private instrument (#505): a known id workspace A must not be able to use. */
  let privateOfB: string;
  /** Workspace A's own private instrument. */
  let privateOfA: string;

  async function createInstrument(name: string): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO instruments (ticker, exchange, name, type, currency) VALUES ($1, 'XMIL', $2, 'fund', 'EUR') RETURNING id",
      [`P${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`, name],
    );
    return rows[0]!.id;
  }

  async function createPrivateInstrument(workspaceId: string, name: string): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO instruments (workspace_id, name, type, currency) VALUES ($1, $2, 'other', 'EUR') RETURNING id",
      [workspaceId, name],
    );
    return rows[0]!.id;
  }

  async function createWorkspace(name: string): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ($1, 'EUR', 'Europe/Rome') RETURNING id",
      [name],
    );
    return rows[0]!.id;
  }

  /** Runs `fn` as envelope_app in a transaction rolled back afterwards, with the session variables given. */
  async function as<T>(
    session: { readonly workspaceId?: string; readonly systemJob?: boolean },
    fn: (client: DbClient) => Promise<T>,
  ): Promise<T> {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      if (session.workspaceId !== undefined) {
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [session.workspaceId]);
      }
      if (session.systemJob === true) {
        await client.query("SELECT set_config('app.is_system_job', 'true', true)");
      }
      return await fn(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  async function rejectsWith(fn: () => Promise<unknown>, code: string, constraint?: string): Promise<void> {
    await assert.rejects(fn, (error: { code?: string; constraint?: string }) => {
      assert.equal(error.code, code, `expected ${code}, got ${String(error.code)}`);
      if (constraint !== undefined) {
        assert.equal(error.constraint, constraint);
      }
      return true;
    });
  }

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(databaseUrl));

    instrumentId = await createInstrument("Prices test fund");
    otherInstrumentId = await createInstrument("Prices test fund without prices");
    workspaceA = await createWorkspace("Prices A");
    workspaceB = await createWorkspace("Prices B");
    privateOfA = await createPrivateInstrument(workspaceA, "Flat of A");
    privateOfB = await createPrivateInstrument(workspaceB, "Flat of B");
    userA = (
      await superuserPool.query<{ id: string }>("INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id", [
        randomUUID(),
        `${randomUUID()}@example.com`,
      ])
    ).rows[0]!.id;

    // Shared provider prices (as a system job would write them) and workspace A's own prices.
    await superuserPool.query(
      `INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source, provider) VALUES
         (NULL, $1, '2026-03-30', 101000000, 'provider', 'test'),
         (NULL, $1, '2026-03-31', 102000000, 'provider', 'test'),
         ($2, $1, '2026-03-31', 99000000, 'manual', NULL)`,
      [instrumentId, workspaceA],
    );
  });

  after(async () => {
    await superuserPool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[workspaceA, workspaceB]]);
    await superuserPool.query("DELETE FROM prices WHERE instrument_id = ANY($1)", [[instrumentId, otherInstrumentId]]);
    await superuserPool.query("DELETE FROM instruments WHERE id = ANY($1)", [[instrumentId, otherInstrumentId]]);
    await superuserPool.query("DELETE FROM users WHERE id = $1", [userA]);
    await appPool.end();
    await superuserPool.end();
  });

  describe("prices isolation", () => {
    it("shows a workspace the shared prices and its own, and another workspace only the shared ones", async () => {
      const query = "SELECT workspace_id, to_char(price_date, 'YYYY-MM-DD') AS date FROM prices WHERE instrument_id = $1 ORDER BY 2, 1";
      const seenByA = await as({ workspaceId: workspaceA }, (client) => client.query(query, [instrumentId]));
      assert.deepEqual(seenByA.rows, [
        { workspace_id: null, date: "2026-03-30" },
        { workspace_id: workspaceA, date: "2026-03-31" },
        { workspace_id: null, date: "2026-03-31" },
      ]);
      const seenByB = await as({ workspaceId: workspaceB }, (client) => client.query(query, [instrumentId]));
      assert.deepEqual(seenByB.rows, [
        { workspace_id: null, date: "2026-03-30" },
        { workspace_id: null, date: "2026-03-31" },
      ]);
      const seenWithoutWorkspace = await as({}, (client) => client.query(query, [instrumentId]));
      assert.deepEqual(seenWithoutWorkspace.rows, seenByB.rows);
      const seenBySystemJob = await as({ systemJob: true }, (client) => client.query(query, [instrumentId]));
      assert.deepEqual(seenBySystemJob.rows, seenByB.rows, "the system flag widens writes to shared rows, never reads of a workspace's");
    });

    it("does not let another workspace update or delete a workspace's price, even knowing its id", async () => {
      await as({ workspaceId: workspaceB }, async (client) => {
        const updated = await client.query("UPDATE prices SET close_e6 = 1 WHERE workspace_id = $1", [workspaceA]);
        assert.equal(updated.rowCount, 0);
        const deleted = await client.query("DELETE FROM prices WHERE workspace_id = $1", [workspaceA]);
        assert.equal(deleted.rowCount, 0);
        await rejectsWith(
          () =>
            client.query(
              "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source) VALUES ($1, $2, '2026-04-01', 1, 'manual')",
              [workspaceA, instrumentId],
            ),
          INSUFFICIENT_PRIVILEGE,
        );
      });
      const { rows } = await superuserPool.query<{ close_e6: string }>("SELECT close_e6 FROM prices WHERE workspace_id = $1", [workspaceA]);
      assert.deepEqual(rows, [{ close_e6: "99000000" }]);
    });

    it("does not let a request insert, update or delete a shared price", async () => {
      await as({ workspaceId: workspaceA }, async (client) => {
        await rejectsWith(
          () =>
            client.query(
              "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source, provider) VALUES (NULL, $1, '2026-04-01', 1, 'provider', 'test')",
              [instrumentId],
            ),
          INSUFFICIENT_PRIVILEGE,
        );
      });
      await as({ workspaceId: workspaceA }, async (client) => {
        const updated = await client.query("UPDATE prices SET close_e6 = 1 WHERE workspace_id IS NULL");
        assert.equal(updated.rowCount, 0);
        const deleted = await client.query("DELETE FROM prices WHERE workspace_id IS NULL");
        assert.equal(deleted.rowCount, 0);
      });
      const { rows } = await superuserPool.query("SELECT close_e6 FROM prices WHERE workspace_id IS NULL AND instrument_id = $1 ORDER BY price_date", [
        instrumentId,
      ]);
      assert.deepEqual(rows, [{ close_e6: "101000000" }, { close_e6: "102000000" }]);
    });

    it("lets a system job insert, update and delete shared prices", async () => {
      await as({ systemJob: true }, async (client) => {
        await client.query(
          "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source, provider) VALUES (NULL, $1, '2026-04-01', 103000000, 'provider', 'test')",
          [instrumentId],
        );
        const updated = await client.query("UPDATE prices SET close_e6 = close_e6 + 1, updated_at = now() WHERE workspace_id IS NULL AND instrument_id = $1", [
          instrumentId,
        ]);
        assert.equal(updated.rowCount, 3);
        const deleted = await client.query("DELETE FROM prices WHERE workspace_id IS NULL AND instrument_id = $1", [instrumentId]);
        assert.equal(deleted.rowCount, 3);
        // Still not a workspace's own price: the flag opens shared rows only.
        await rejectsWith(
          () =>
            client.query(
              "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source) VALUES ($1, $2, '2026-04-01', 1, 'manual')",
              [workspaceA, instrumentId],
            ),
          INSUFFICIENT_PRIVILEGE,
        );
      });
    });

    it("refuses a price on an instrument the caller cannot see: another workspace's private one, or an unknown id", async () => {
      for (const hidden of [privateOfB, randomUUID()]) {
        await as({ workspaceId: workspaceA }, async (client) => {
          await rejectsWith(
            () => upsertWorkspacePrices(client, workspaceA, hidden, [{ priceDate: "2026-04-01", closeE6: 1 }], "manual"),
            CHECK_VIOLATION,
            "instrument_not_found",
          );
        });
      }
      const { rows } = await superuserPool.query("SELECT 1 FROM prices WHERE instrument_id = $1", [privateOfB]);
      assert.deepEqual(rows, []);
    });

    it("refuses a price of one workspace on another workspace's private instrument even to a caller that bypasses Row-Level Security", async () => {
      await rejectsWith(
        () =>
          superuserPool.query(
            "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source) VALUES ($1, $2, '2026-04-01', 1, 'manual')",
            [workspaceA, privateOfB],
          ),
        CHECK_VIOLATION,
        "instrument_not_found",
      );
    });

    it("takes a workspace's manual and CSV prices on its own private instrument, seen by that workspace only", async () => {
      await as({ workspaceId: workspaceA }, async (client) => {
        assert.deepEqual(
          await upsertWorkspacePrices(client, workspaceA, privateOfA, [{ priceDate: "2026-04-01", closeE6: 250_000_000_000 }], "manual", userA),
          { inserted: 1, replaced: 0, unchanged: 0 },
        );
        assert.deepEqual(await upsertWorkspacePrices(client, workspaceA, privateOfA, [{ priceDate: "2026-04-01", closeE6: 260_000_000_000 }], "csv"), {
          inserted: 0,
          replaced: 1,
          unchanged: 0,
        });
        const candidates = await loadPriceCandidates(client, workspaceA, [privateOfA], "2026-12-31");
        assert.deepEqual(candidates.get(privateOfA), [{ priceDate: "2026-04-01", closeE6: 260_000_000_000, origin: "own" }]);
        assert.equal(await deleteWorkspacePrice(client, workspaceA, privateOfA, "2026-04-01"), true);
      });
    });

    it("refuses a shared price on a private instrument, even from a system job or a caller that bypasses Row-Level Security", async () => {
      await as({ systemJob: true }, async (client) => {
        await rejectsWith(
          () =>
            client.query(
              "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source, provider) VALUES (NULL, $1, '2026-04-01', 1, 'provider', 'test')",
              [privateOfA],
            ),
          CHECK_VIOLATION,
          "instrument_not_found",
        );
      });
      await rejectsWith(
        () =>
          superuserPool.query(
            "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source, provider) VALUES (NULL, $1, '2026-04-01', 1, 'provider', 'test')",
            [privateOfA],
          ),
        CHECK_VIOLATION,
        "instrument_not_found",
      );
    });

    it("gives a request no way to move a price to another workspace, instrument or date, or to make it shared", async () => {
      for (const [column, value] of [
        ["workspace_id", null],
        ["instrument_id", otherInstrumentId],
        ["price_date", "2026-04-02"],
        ["provider", "test"],
        ["created_by", null],
      ] as const) {
        await as({ workspaceId: workspaceA }, async (client) => {
          await rejectsWith(
            () => client.query(`UPDATE prices SET ${column} = $1 WHERE workspace_id = $2`, [value, workspaceA]),
            INSUFFICIENT_PRIVILEGE,
          );
        });
      }
    });

    it("loads only the shared candidates for another workspace, even when asked for the first one's", async () => {
      const candidates = await as({ workspaceId: workspaceB }, (client) => loadPriceCandidates(client, workspaceA, [instrumentId], "2026-12-31"));
      assert.deepEqual(candidates.get(instrumentId), [
        { priceDate: "2026-03-30", closeE6: 101000000, origin: "shared" },
        { priceDate: "2026-03-31", closeE6: 102000000, origin: "shared" },
      ]);
      const listed = await as({ workspaceId: workspaceB }, (client) => listPrices(client, workspaceA, instrumentId, "2026-01-01", "2026-12-31"));
      assert.deepEqual(
        listed.map((price) => price.origin),
        ["shared", "shared"],
      );
    });
  });

  describe("constraints", () => {
    it("ties a shared row to a provider and a workspace row to a manual or CSV source", async () => {
      for (const [workspaceId, source, provider, constraint] of [
        [null, "manual", "test", "prices_shared_source_check"],
        ["A", "provider", null, "prices_shared_source_check"],
        ["A", "manual", "test", "prices_shared_provider_check"],
        [null, "provider", null, "prices_shared_provider_check"],
      ] as const) {
        await rejectsWith(
          () =>
            superuserPool.query(
              "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source, provider) VALUES ($1, $2, '2026-05-01', 1, $3, $4)",
              [workspaceId === "A" ? workspaceA : null, instrumentId, source, provider],
            ),
          CHECK_VIOLATION,
          constraint,
        );
      }
    });

    it("keeps one shared price and one price per workspace for an instrument on a date", async () => {
      await rejectsWith(
        () =>
          superuserPool.query(
            "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source, provider) VALUES (NULL, $1, '2026-03-31', 1, 'provider', 'other')",
            [instrumentId],
          ),
        UNIQUE_VIOLATION,
        "prices_workspace_instrument_date_key",
      );
    });

    it("keeps a close within zero and the largest safe integer", async () => {
      for (const close of ["-1", "9007199254740992"]) {
        await rejectsWith(
          () =>
            superuserPool.query(
              "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source) VALUES ($1, $2, '2026-05-01', $3, 'manual')",
              [workspaceA, instrumentId, close],
            ),
          CHECK_VIOLATION,
          "prices_close_e6_check",
        );
      }
    });
  });

  describe("upsertWorkspacePrices", () => {
    it("inserts new dates, replaces a changed close, leaves an equal one alone, and never touches the shared price", async () => {
      await as({ workspaceId: workspaceA }, async (client) => {
        const first = await upsertWorkspacePrices(
          client,
          workspaceA,
          instrumentId,
          [
            { priceDate: "2026-03-31", closeE6: 99000000 },
            { priceDate: "2026-04-01", closeE6: 0 },
            { priceDate: "2026-04-02", closeE6: Number.MAX_SAFE_INTEGER },
          ],
          "csv",
          userA,
        );
        assert.deepEqual(first, { inserted: 2, replaced: 0, unchanged: 1 });

        const second = await upsertWorkspacePrices(
          client,
          workspaceA,
          instrumentId,
          [
            { priceDate: "2026-03-31", closeE6: 98000000 },
            { priceDate: "2026-04-01", closeE6: 0 },
          ],
          "csv",
        );
        assert.deepEqual(second, { inserted: 0, replaced: 1, unchanged: 1 });

        const listed = await listPrices(client, workspaceA, instrumentId, "2026-03-31", "2026-04-30");
        assert.deepEqual(listed, [
          { priceDate: "2026-03-31", closeE6: 102000000, source: "provider", origin: "shared" },
          { priceDate: "2026-03-31", closeE6: 98000000, source: "csv", origin: "own" },
          { priceDate: "2026-04-01", closeE6: 0, source: "csv", origin: "own" },
          { priceDate: "2026-04-02", closeE6: Number.MAX_SAFE_INTEGER, source: "csv", origin: "own" },
        ]);
      });
    });

    it("answers a repeated submission with every date unchanged", async () => {
      await as({ workspaceId: workspaceA }, async (client) => {
        const rows = [{ priceDate: "2026-06-01", closeE6: 50000000 }];
        assert.deepEqual(await upsertWorkspacePrices(client, workspaceA, instrumentId, rows, "manual"), { inserted: 1, replaced: 0, unchanged: 0 });
        assert.deepEqual(await upsertWorkspacePrices(client, workspaceA, instrumentId, rows, "manual"), { inserted: 0, replaced: 0, unchanged: 1 });
        assert.deepEqual(await upsertWorkspacePrices(client, workspaceA, instrumentId, [], "manual"), { inserted: 0, replaced: 0, unchanged: 0 });
      });
    });

    it("refuses a date given twice, a malformed date and an out-of-range close, before writing anything", async () => {
      await as({ workspaceId: workspaceA }, async (client) => {
        await assert.rejects(
          () =>
            upsertWorkspacePrices(
              client,
              workspaceA,
              instrumentId,
              [
                { priceDate: "2026-07-01", closeE6: 1 },
                { priceDate: "2026-07-01", closeE6: 2 },
              ],
              "csv",
            ),
          (error) => isValidationError(error, "duplicate_price") && error.details.date === "2026-07-01",
        );
        await assert.rejects(
          () => upsertWorkspacePrices(client, workspaceA, instrumentId, [{ priceDate: "2026-02-29", closeE6: 1 }], "manual"),
          (error) => isValidationError(error, "invalid_date"),
        );
        for (const closeE6 of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
          await assert.rejects(
            () => upsertWorkspacePrices(client, workspaceA, instrumentId, [{ priceDate: "2026-07-02", closeE6 }], "manual"),
            (error) => isValidationError(error, "invalid_price"),
            String(closeE6),
          );
        }
        const { rows } = await client.query("SELECT 1 FROM prices WHERE price_date >= '2026-07-01'");
        assert.deepEqual(rows, []);
      });
    });

    it("cannot write into another workspace than the one the request selected", async () => {
      await as({ workspaceId: workspaceB }, async (client) => {
        await rejectsWith(
          () => upsertWorkspacePrices(client, workspaceA, instrumentId, [{ priceDate: "2026-08-01", closeE6: 1 }], "manual"),
          INSUFFICIENT_PRIVILEGE,
        );
      });
    });
  });

  describe("deleteWorkspacePrice", () => {
    it("deletes the workspace's own price and leaves the shared price of the same date", async () => {
      await as({ workspaceId: workspaceA }, async (client) => {
        assert.equal(await deleteWorkspacePrice(client, workspaceA, instrumentId, "2026-03-31"), true);
        assert.equal(await deleteWorkspacePrice(client, workspaceA, instrumentId, "2026-03-31"), false, "a second delete finds nothing");
        assert.equal(await deleteWorkspacePrice(client, workspaceA, instrumentId, "2026-03-30"), false, "only a shared price on that date");
        const listed = await listPrices(client, workspaceA, instrumentId, "2026-03-30", "2026-03-31");
        assert.deepEqual(
          listed.map((price) => [price.priceDate, price.origin]),
          [
            ["2026-03-30", "shared"],
            ["2026-03-31", "shared"],
          ],
        );
      });
    });

    it("does not delete another workspace's price", async () => {
      await as({ workspaceId: workspaceB }, async (client) => {
        assert.equal(await deleteWorkspacePrice(client, workspaceA, instrumentId, "2026-03-31"), false);
      });
    });
  });

  describe("listPrices and loadPriceCandidates", () => {
    it("lists own and shared prices within the range, both ends included", async () => {
      const listed = await as({ workspaceId: workspaceA }, (client) => listPrices(client, workspaceA, instrumentId, "2026-03-31", "2026-03-31"));
      assert.deepEqual(listed, [
        { priceDate: "2026-03-31", closeE6: 102000000, source: "provider", origin: "shared" },
        { priceDate: "2026-03-31", closeE6: 99000000, source: "manual", origin: "own" },
      ]);
    });

    it("loads own and shared candidates up to a date, with an empty entry for an instrument without prices", async () => {
      const candidates = await as({ workspaceId: workspaceA }, (client) =>
        loadPriceCandidates(client, workspaceA, [instrumentId, otherInstrumentId], "2026-03-30"),
      );
      assert.deepEqual(
        [...candidates.entries()],
        [
          [instrumentId, [{ priceDate: "2026-03-30", closeE6: 101000000, origin: "shared" }]],
          [otherInstrumentId, []],
        ],
      );
      const none = await as({ workspaceId: workspaceA }, (client) => loadPriceCandidates(client, workspaceA, [], "2026-03-30"));
      assert.equal(none.size, 0);
    });

    it("loads both candidates of a date with its own and a shared price", async () => {
      const candidates = await as({ workspaceId: workspaceA }, (client) => loadPriceCandidates(client, workspaceA, [instrumentId], "2026-03-31"));
      assert.deepEqual(
        candidates.get(instrumentId)?.filter((candidate) => candidate.priceDate === "2026-03-31").map((candidate) => candidate.origin).sort(),
        ["own", "shared"],
      );
    });
  });

  it("removes a workspace's prices with the workspace and keeps the shared ones", async () => {
    const workspaceId = await createWorkspace("Prices doomed");
    await superuserPool.query(
      "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source) VALUES ($1, $2, '2026-03-31', 1, 'manual')",
      [workspaceId, instrumentId],
    );
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    const { rows } = await superuserPool.query<{ count: string }>(
      "SELECT count(*) FILTER (WHERE workspace_id = $1) AS own, count(*) FILTER (WHERE workspace_id IS NULL) AS shared FROM prices WHERE instrument_id = $2",
      [workspaceId, instrumentId],
    );
    assert.deepEqual(rows, [{ own: "0", shared: "2" }]);
  });
});
