import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { normalizePrivateInstrument } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbClient, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { deleteWorkspace } from "../workspaces/repository.ts";
import { createInstrument, getInstrument, getInstruments, listWorkspaceInstruments, searchInstruments } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";

/** Private instruments (#505, migration 0035), and the guards on what may point at one, as the envelope_app role. */
describe("private instruments (#505), as the envelope_app role", () => {
  let superuserPool: DbPool;
  let appPool: DbPool;
  let workspaceA: string;
  let workspaceB: string;
  let shared: string;
  let privateOfA: string;
  /** Workspace B's private instrument: a known id workspace A must neither find nor reference. */
  let privateOfB: string;
  let userA: string;
  // Every instrument this file creates has a name starting with this, so a name search sees only this run's rows.
  const namePrefix = `Priv${randomUUID().slice(0, 8)}`;

  async function createWorkspace(name: string): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO workspaces (name, base_currency, time_zone) VALUES ($1, 'EUR', 'Europe/Rome') RETURNING id",
      [name],
    );
    return rows[0]!.id;
  }

  async function createPrivate(workspaceId: string, name: string): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO instruments (workspace_id, name, type, currency) VALUES ($1, $2, 'other', 'EUR') RETURNING id",
      [workspaceId, `${namePrefix} ${name}`],
    );
    return rows[0]!.id;
  }

  /** A brokerage account and a portfolio in the workspace, for a trade. */
  async function holdings(workspaceId: string): Promise<{ accountId: string; portfolioId: string }> {
    const account = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Broker', 'brokerage', 'EUR', false) RETURNING id",
      [workspaceId],
    );
    const portfolio = await superuserPool.query<{ id: string }>("INSERT INTO portfolios (workspace_id, name) VALUES ($1, $2) RETURNING id", [
      workspaceId,
      `Growth ${randomUUID()}`,
    ]);
    return { accountId: account.rows[0]!.id, portfolioId: portfolio.rows[0]!.id };
  }

  const INSERT_BUY = `INSERT INTO trades (workspace_id, account_id, portfolio_id, instrument_id, type, trade_date, quantity_e8, price_e6, gross_cents)
     VALUES ($1, $2, $3, $4, 'buy', '2026-01-10', 100000000, 1000000, 100) RETURNING id`;

  /** Runs `fn` as envelope_app in a transaction rolled back afterwards, with the session variables given. */
  async function as<T>(
    session: { readonly workspaceId?: string; readonly userId?: string; readonly systemJob?: boolean },
    fn: (client: DbClient) => Promise<T>,
  ): Promise<T> {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      if (session.workspaceId !== undefined) {
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [session.workspaceId]);
      }
      if (session.userId !== undefined) {
        await client.query("SELECT set_config('app.user_id', $1, true)", [session.userId]);
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

    workspaceA = await createWorkspace("Private A");
    workspaceB = await createWorkspace("Private B");
    userA = (
      await superuserPool.query<{ id: string }>("INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id", [
        randomUUID(),
        `${randomUUID()}@example.com`,
      ])
    ).rows[0]!.id;
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [userA, workspaceA]);
    shared = (
      await superuserPool.query<{ id: string }>(
        "INSERT INTO instruments (ticker, exchange, name, type, currency) VALUES ($1, 'XMIL', $2, 'fund', 'EUR') RETURNING id",
        [`P${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`, `${namePrefix} shared fund`],
      )
    ).rows[0]!.id;
    privateOfA = await createPrivate(workspaceA, "flat of A");
    privateOfB = await createPrivate(workspaceB, "flat of B");
  });

  after(async () => {
    // The private instruments, trades and prices go with their workspaces.
    await superuserPool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[workspaceA, workspaceB]]);
    await superuserPool.query("DELETE FROM instruments WHERE id = $1", [shared]);
    await superuserPool.query("DELETE FROM users WHERE id = $1", [userA]);
    await appPool.end();
    await superuserPool.end();
  });

  describe("instruments isolation", () => {
    const query = "SELECT id FROM instruments WHERE id = ANY($1) ORDER BY id";

    it("shows a workspace the shared instruments and its own, never another workspace's", async () => {
      const ids = (): string[] => [shared, privateOfA, privateOfB];
      const seenByA = await as({ workspaceId: workspaceA }, (client) => client.query<{ id: string }>(query, [ids()]));
      assert.deepEqual(seenByA.rows.map((row) => row.id), [shared, privateOfA].sort());
      const seenByB = await as({ workspaceId: workspaceB }, (client) => client.query<{ id: string }>(query, [ids()]));
      assert.deepEqual(seenByB.rows.map((row) => row.id), [shared, privateOfB].sort());
    });

    it("shows a caller with no workspace (the /instruments routes, a system job) the shared catalog only", async () => {
      for (const session of [{}, { userId: userA }, { systemJob: true }]) {
        const seen = await as(session, (client) => client.query<{ id: string }>(query, [[shared, privateOfA, privateOfB]]));
        assert.deepEqual(seen.rows.map((row) => row.id), [shared], JSON.stringify(session));
      }
      const viaPool = await getInstrument(appPool, privateOfA);
      assert.equal(viaPool, undefined, "the pool, as the /instruments routes use it, never sees a private instrument");
      const searched = await searchInstruments(appPool, { kind: "prefix", prefix: namePrefix });
      assert.deepEqual(searched.map((instrument) => instrument.id), [shared]);
    });

    it("finds a private instrument through the repository for its own workspace only", async () => {
      await as({ workspaceId: workspaceA }, async (client) => {
        assert.equal((await getInstrument(client, privateOfA))?.workspaceId, workspaceA);
        assert.equal(await getInstrument(client, privateOfB), undefined);
        assert.deepEqual([...(await getInstruments(client, [shared, privateOfA, privateOfB])).keys()].sort(), [shared, privateOfA].sort());
        assert.deepEqual((await listWorkspaceInstruments(client, workspaceA)).map((instrument) => instrument.id), [privateOfA]);
        assert.deepEqual(await listWorkspaceInstruments(client, workspaceB), [], "asking for B's list from A's request still finds nothing");
      });
    });

    it("lets a workspace add its own private instrument, and nobody add one to another workspace", async () => {
      const flat = normalizePrivateInstrument({ name: `${namePrefix} new flat`, type: "other", currency: "EUR" });
      await as({ workspaceId: workspaceA }, async (client) => {
        const created = await createInstrument(client, userA, flat, workspaceA);
        assert.equal(created.workspaceId, workspaceA);
        assert.equal(created.isin, null);
        await rejectsWith(() => createInstrument(client, userA, flat, workspaceB), INSUFFICIENT_PRIVILEGE);
      });
      for (const session of [{}, { systemJob: true }]) {
        await as(session, async (client) => {
          await rejectsWith(() => createInstrument(client, userA, flat, workspaceA), INSUFFICIENT_PRIVILEGE);
        });
      }
    });

    it("lets nobody update or delete an instrument, shared or private", async () => {
      for (const id of [shared, privateOfA, privateOfB]) {
        for (const statement of ["UPDATE instruments SET name = 'Changed' WHERE id = $1", "DELETE FROM instruments WHERE id = $1"]) {
          await as({ workspaceId: workspaceA }, async (client) => {
            await rejectsWith(() => client.query(statement, [id]), INSUFFICIENT_PRIVILEGE);
          });
        }
      }
    });
  });

  describe("constraints", () => {
    it("keeps identifiers off a private instrument and requires one on a shared instrument", async () => {
      for (const [columns, values] of [
        ["workspace_id, isin", [workspaceA, "US0378331005"]],
        ["workspace_id, ticker, exchange", [workspaceA, "FLAT", "XMIL"]],
        ["workspace_id, exchange", [workspaceA, "XMIL"]],
        ["workspace_id", [null]],
      ] as const) {
        const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
        await rejectsWith(
          () =>
            superuserPool.query(`INSERT INTO instruments (${columns}, name, type, currency) VALUES (${placeholders}, 'X', 'other', 'EUR')`, [
              ...values,
            ]),
          CHECK_VIOLATION,
          "instruments_identifier_check",
        );
      }
    });
  });

  describe("trades on a private instrument", () => {
    it("lets a workspace trade its own private instrument and a shared one", async () => {
      const { accountId, portfolioId } = await holdings(workspaceA);
      await as({ workspaceId: workspaceA }, async (client) => {
        for (const instrumentId of [privateOfA, shared]) {
          const { rowCount } = await client.query(INSERT_BUY, [workspaceA, accountId, portfolioId, instrumentId]);
          assert.equal(rowCount, 1);
        }
      });
    });

    it("refuses a trade on another workspace's private instrument, inserted or moved there, even to a caller that bypasses Row-Level Security", async () => {
      const { accountId, portfolioId } = await holdings(workspaceA);
      await as({ workspaceId: workspaceA }, async (client) => {
        await rejectsWith(() => client.query(INSERT_BUY, [workspaceA, accountId, portfolioId, privateOfB]), CHECK_VIOLATION, "instrument_not_found");
      });
      await as({ workspaceId: workspaceA }, async (client) => {
        await rejectsWith(() => client.query(INSERT_BUY, [workspaceA, accountId, portfolioId, randomUUID()]), CHECK_VIOLATION, "instrument_not_found");
      });
      await as({ workspaceId: workspaceA }, async (client) => {
        const { rows } = await client.query<{ id: string }>(INSERT_BUY, [workspaceA, accountId, portfolioId, shared]);
        await rejectsWith(
          () => client.query("UPDATE trades SET instrument_id = $1 WHERE id = $2", [privateOfB, rows[0]!.id]),
          CHECK_VIOLATION,
          "instrument_not_found",
        );
      });
      await rejectsWith(() => superuserPool.query(INSERT_BUY, [workspaceA, accountId, portfolioId, privateOfB]), CHECK_VIOLATION, "instrument_not_found");
    });

    it("still takes a fee or a tax with no instrument", async () => {
      const { accountId, portfolioId } = await holdings(workspaceA);
      await as({ workspaceId: workspaceA }, async (client) => {
        const { rowCount } = await client.query(
          `INSERT INTO trades (workspace_id, account_id, portfolio_id, type, trade_date, fees_cents) VALUES ($1, $2, $3, 'fee', '2026-01-10', 100)`,
          [workspaceA, accountId, portfolioId],
        );
        assert.equal(rowCount, 1);
      });
    });
  });

  it("removes a workspace's private instruments, with the trades and prices on them, when the workspace is deleted", async () => {
    const doomed = await createWorkspace("Private doomed");
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [userA, doomed]);
    const flat = await createPrivate(doomed, "doomed flat");
    const { accountId, portfolioId } = await holdings(doomed);
    await superuserPool.query(INSERT_BUY, [doomed, accountId, portfolioId, flat]);
    await superuserPool.query(
      "INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source) VALUES ($1, $2, '2026-03-31', 1, 'manual')",
      [doomed, flat],
    );

    // As the DELETE /workspaces/:workspaceId route does it: envelope_app, inside the workspace.
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [doomed]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [userA]);
      await deleteWorkspace(client, doomed);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const { rows } = await superuserPool.query("SELECT 1 FROM instruments WHERE id = $1", [flat]);
    assert.deepEqual(rows, []);
  });
});
