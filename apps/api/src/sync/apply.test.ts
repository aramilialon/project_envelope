import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Hlc } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { createTrades, type TradeEntryInput, type TradeRecord } from "../trades/repository.ts";
import { createTransaction } from "../transactions/repository.ts";
import { afterApply, applyIncomingChange, beforeApply, type IncomingChange, isLocked } from "./apply.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("applyIncomingChange (#43)", () => {
  let pool: DbPool;
  let workspaceId: string;
  let accountId: string;
  let otherWorkspaceId: string;
  let otherAccountId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    workspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [workspaceId]);
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    accountId = account.rows[0]!.id;

    otherWorkspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Other', 'EUR', 'UTC')", [
      otherWorkspaceId,
    ]);
    const otherAccount = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [otherWorkspaceId],
    );
    otherAccountId = otherAccount.rows[0]!.id;
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[workspaceId, otherWorkspaceId]]);
    await pool.end();
  });

  async function createTestTransaction(inOtherWorkspace = false): Promise<string> {
    const tx = await createTransaction(pool, {
      workspaceId: inOtherWorkspace ? otherWorkspaceId : workspaceId,
      accountId: inOtherWorkspace ? otherAccountId : accountId,
      occurredAt: "2026-09-01",
      splits: [{ categoryId: null, amountCents: 1000 }],
    });
    return tx.id;
  }

  async function memoOf(transactionId: string): Promise<string | null> {
    const { rows } = await pool.query<{ memo: string | null }>("SELECT memo FROM transactions WHERE id = $1", [transactionId]);
    return rows[0]?.memo ?? null;
  }

  function hlc(physical: number, counter = 0, deviceId = "device-a"): Hlc {
    return { physical, counter, deviceId };
  }

  async function changeLogRows(changeId: string): Promise<{ workspace_id: string; value: unknown; outcome: string }[]> {
    const { rows } = await pool.query<{ workspace_id: string; value: unknown; outcome: string }>(
      "SELECT workspace_id, value, outcome FROM change_log WHERE id = $1 ORDER BY workspace_id",
      [changeId],
    );
    return rows;
  }

  async function reconcile(transactionId: string): Promise<void> {
    await pool.query("UPDATE transactions SET status = 'reconciled' WHERE id = $1", [transactionId]);
  }

  it("applies a first change to the real column", async () => {
    const transactionId = await createTestTransaction();
    const outcome = await applyIncomingChange(pool, workspaceId, {
      id: randomUUID(),
      entityId: transactionId,
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: "Groceries",
    });

    assert.equal(outcome, "applied");
    assert.equal(await memoOf(transactionId), "Groceries");
  });

  it("converges to the change with the later clock when the later one arrives first", async () => {
    const transactionId = await createTestTransaction();

    const later = await applyIncomingChange(pool, workspaceId, {
      id: randomUUID(),
      entityId: transactionId,
      fieldName: "transactions.memo",
      hlc: hlc(2000),
      value: "later",
    });
    const earlier = await applyIncomingChange(pool, workspaceId, {
      id: randomUUID(),
      entityId: transactionId,
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: "earlier",
    });

    assert.equal(later, "applied");
    assert.equal(earlier, "stale");
    assert.equal(await memoOf(transactionId), "later");
  });

  it("converges to the same result when the later one arrives second", async () => {
    const transactionId = await createTestTransaction();

    const earlier = await applyIncomingChange(pool, workspaceId, {
      id: randomUUID(),
      entityId: transactionId,
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: "earlier",
    });
    const later = await applyIncomingChange(pool, workspaceId, {
      id: randomUUID(),
      entityId: transactionId,
      fieldName: "transactions.memo",
      hlc: hlc(2000),
      value: "later",
    });

    assert.equal(earlier, "applied");
    assert.equal(later, "applied");
    assert.equal(await memoOf(transactionId), "later");
  });

  it("keeps two fields of the same entity independent", async () => {
    const transactionId = await createTestTransaction();
    await applyIncomingChange(pool, workspaceId, {
      id: randomUUID(),
      entityId: transactionId,
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: "a memo",
    });
    await applyIncomingChange(pool, workspaceId, {
      id: randomUUID(),
      entityId: transactionId,
      fieldName: "transactions.payee",
      hlc: hlc(1000),
      value: "a payee",
    });

    const { rows } = await pool.query<{ memo: string | null; payee: string | null }>(
      "SELECT memo, payee FROM transactions WHERE id = $1",
      [transactionId],
    );
    assert.equal(rows[0]?.memo, "a memo");
    assert.equal(rows[0]?.payee, "a payee");
  });

  it("reports an unsupported field without recording or applying it", async () => {
    const transactionId = await createTestTransaction();
    const changeId = randomUUID();

    const outcome = await applyIncomingChange(pool, workspaceId, {
      id: changeId,
      entityId: transactionId,
      fieldName: "transactions.occurred_at",
      hlc: hlc(1000),
      value: "2026-10-01",
    });

    assert.equal(outcome, "unsupported_field");
    const { rows } = await pool.query("SELECT 1 FROM change_log WHERE id = $1", [changeId]);
    assert.equal(rows.length, 0, "an unsupported field must not be recorded either, since there is nowhere to apply it");
  });

  it("rejects a change to a reconciled transaction, without recording or applying it (#45)", async () => {
    const transactionId = await createTestTransaction();
    await applyIncomingChange(pool, workspaceId, {
      id: randomUUID(),
      entityId: transactionId,
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: "before reconciling",
    });
    await reconcile(transactionId);
    const changeId = randomUUID();

    const outcome = await applyIncomingChange(pool, workspaceId, {
      id: changeId,
      entityId: transactionId,
      fieldName: "transactions.memo",
      hlc: hlc(2000),
      value: "after reconciling",
    });

    assert.equal(outcome, "locked");
    assert.equal(await memoOf(transactionId), "before reconciling", "a locked transaction's field must not change");
    const { rows } = await pool.query("SELECT 1 FROM change_log WHERE id = $1", [changeId]);
    assert.equal(rows.length, 0, "a rejected change must not be recorded either, so a retry after unlocking is unaffected by it");
  });

  it("applies again once a reconciled transaction is unlocked", async () => {
    const transactionId = await createTestTransaction();
    await reconcile(transactionId);
    const rejected = await applyIncomingChange(pool, workspaceId, {
      id: randomUUID(),
      entityId: transactionId,
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: "while locked",
    });
    assert.equal(rejected, "locked");

    await pool.query("UPDATE transactions SET status = 'cleared' WHERE id = $1", [transactionId]);
    const retried = await applyIncomingChange(pool, workspaceId, {
      id: randomUUID(),
      entityId: transactionId,
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: "after unlocking",
    });

    assert.equal(retried, "applied");
    assert.equal(await memoOf(transactionId), "after unlocking");
  });

  describe("entities and change ids outside the workspace (#513)", () => {
    it("answers not_found for another workspace's real transaction, applying and recording nothing", async () => {
      const foreignTransactionId = await createTestTransaction(true);
      const changeId = randomUUID();

      const outcome = await applyIncomingChange(pool, workspaceId, {
        id: changeId,
        entityId: foreignTransactionId,
        fieldName: "transactions.memo",
        hlc: hlc(1000),
        value: "not yours",
      });

      assert.equal(outcome, "not_found");
      assert.equal(await memoOf(foreignTransactionId), null);
      assert.deepEqual(await changeLogRows(changeId), []);
    });

    it("answers not_found for a uuid that names no row at all, recording nothing", async () => {
      const changeId = randomUUID();
      const outcome = await applyIncomingChange(pool, workspaceId, {
        id: changeId,
        entityId: randomUUID(),
        fieldName: "transactions.payee",
        hlc: hlc(1000),
        value: "nobody",
      });

      assert.equal(outcome, "not_found");
      assert.deepEqual(await changeLogRows(changeId), []);
    });

    it("answers invalid for a malformed change id or entity id, recording nothing", async () => {
      const transactionId = await createTestTransaction();
      const malformedId = await applyIncomingChange(pool, workspaceId, {
        id: "not-a-uuid",
        entityId: transactionId,
        fieldName: "transactions.memo",
        hlc: hlc(1000),
        value: "x",
      });
      const malformedEntity = await applyIncomingChange(pool, workspaceId, {
        id: randomUUID(),
        entityId: "1; DROP TABLE transactions",
        fieldName: "transactions.memo",
        hlc: hlc(1000),
        value: "x",
      });

      assert.equal(malformedId, "invalid");
      assert.equal(malformedEntity, "invalid");
      assert.equal(await memoOf(transactionId), null);
    });

    it("answers a retry of the same change with its original outcome, without applying it again", async () => {
      const transactionId = await createTestTransaction();
      const first = {
        id: randomUUID(),
        entityId: transactionId,
        fieldName: "transactions.memo",
        hlc: hlc(1000),
        value: "first",
      };
      const stale = { ...first, id: randomUUID(), hlc: hlc(500), value: "older" };

      assert.equal(await applyIncomingChange(pool, workspaceId, first), "applied");
      assert.equal(await applyIncomingChange(pool, workspaceId, stale), "stale");
      await applyIncomingChange(pool, workspaceId, { ...first, id: randomUUID(), hlc: hlc(2000), value: "second" });

      assert.equal(await applyIncomingChange(pool, workspaceId, first), "applied", "a retry gets the outcome it got the first time");
      assert.equal(await applyIncomingChange(pool, workspaceId, stale), "stale");
      assert.equal(await memoOf(transactionId), "second", "a retry must never write its value again over a later one");
      assert.equal((await changeLogRows(first.id)).length, 1);
      assert.equal((await changeLogRows(stale.id)).length, 1);
    });

    it("answers a retry with its original outcome even after the transaction is reconciled", async () => {
      const transactionId = await createTestTransaction();
      const change = { id: randomUUID(), entityId: transactionId, fieldName: "transactions.memo", hlc: hlc(1000), value: "before" };
      assert.equal(await applyIncomingChange(pool, workspaceId, change), "applied");
      await reconcile(transactionId);

      assert.equal(await applyIncomingChange(pool, workspaceId, change), "applied");
    });

    it("refuses a different change sent under an id this workspace already recorded, as id_conflict", async () => {
      const transactionId = await createTestTransaction();
      const changeId = randomUUID();
      const original = { id: changeId, entityId: transactionId, fieldName: "transactions.memo", hlc: hlc(1000), value: "original" };
      assert.equal(await applyIncomingChange(pool, workspaceId, original), "applied");

      for (const different of [
        { ...original, value: "different value" },
        { ...original, hlc: hlc(2000) },
        { ...original, fieldName: "transactions.payee" },
        { ...original, entityId: await createTestTransaction() },
      ]) {
        assert.equal(await applyIncomingChange(pool, workspaceId, different), "id_conflict", JSON.stringify(different));
      }
      assert.equal(await memoOf(transactionId), "original");
      assert.deepEqual(await changeLogRows(changeId), [{ workspace_id: workspaceId, value: "original", outcome: "applied" }]);
    });

    it("treats another workspace's change id as an unrelated change, applying and recording it here", async () => {
      const foreignTransactionId = await createTestTransaction(true);
      const changeId = randomUUID();
      assert.equal(
        await applyIncomingChange(pool, otherWorkspaceId, {
          id: changeId,
          entityId: foreignTransactionId,
          fieldName: "transactions.memo",
          hlc: hlc(1000),
          value: "theirs",
        }),
        "applied",
      );

      const transactionId = await createTestTransaction();
      const outcome = await applyIncomingChange(pool, workspaceId, {
        id: changeId,
        entityId: transactionId,
        fieldName: "transactions.memo",
        hlc: hlc(1000),
        value: "mine",
      });

      assert.equal(outcome, "applied", "the same answer as for a fresh id, so it says nothing about the other workspace");
      assert.equal(await memoOf(transactionId), "mine");
      assert.equal(await memoOf(foreignTransactionId), "theirs");
      const rows = await changeLogRows(changeId);
      assert.deepEqual(
        rows.map((row) => [row.workspace_id, row.value]).sort(),
        [
          [otherWorkspaceId, "theirs"],
          [workspaceId, "mine"],
        ].sort(),
        "each workspace keeps its own change under the shared id",
      );
    });

    describe("two requests sending the same change id at once", () => {
      /**
       * A records the change in an open transaction; B, on another connection, gets past every
       * check (A's row is not committed yet) and its insert waits on A's. Once A commits, B's
       * insert does nothing and B must answer from A's recorded change, applying nothing itself.
       */
      async function race(changeA: IncomingChange, changeB: IncomingChange): Promise<{ a: string; b: string }> {
        const clientA = await pool.connect();
        const clientB = await pool.connect();
        try {
          await clientA.query("BEGIN");
          await clientB.query("BEGIN");
          const { rows } = await clientB.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const pidB = rows[0]!.pid;

          const a = await applyIncomingChange(clientA, workspaceId, changeA);
          let settledB = false;
          const pendingB = applyIncomingChange(clientB, workspaceId, changeB).finally(() => {
            settledB = true;
          });
          for (;;) {
            const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pidB]);
            if (waiting.rows.length > 0) {
              break;
            }
            // B must block on A's row; if it finished instead, the race this test needs never happened.
            assert.equal(settledB, false, "B's insert was expected to wait on A's open transaction");
            await new Promise((resolve) => setImmediate(resolve));
          }
          await clientA.query("COMMIT");
          const b = await pendingB;
          await clientB.query("COMMIT");
          return { a, b };
        } finally {
          clientA.release();
          clientB.release();
        }
      }

      it("answers the second with the first one's outcome when it is the same change", async () => {
        const transactionId = await createTestTransaction();
        const change = { id: randomUUID(), entityId: transactionId, fieldName: "transactions.memo", hlc: hlc(1000), value: "same" };

        assert.deepEqual(await race(change, change), { a: "applied", b: "applied" });
        assert.equal(await memoOf(transactionId), "same");
        assert.equal((await changeLogRows(change.id)).length, 1);
      });

      it("answers the second with id_conflict, applying nothing, when it is a different change", async () => {
        const transactionId = await createTestTransaction();
        const change = { id: randomUUID(), entityId: transactionId, fieldName: "transactions.memo", hlc: hlc(1000), value: "first" };

        assert.deepEqual(await race(change, { ...change, hlc: hlc(2000), value: "second" }), { a: "applied", b: "id_conflict" });
        assert.equal(await memoOf(transactionId), "first", "the losing request must not apply its value");
        assert.deepEqual(await changeLogRows(change.id), [{ workspace_id: workspaceId, value: "first", outcome: "applied" }]);
      });
    });
  });

  describe("trades and their cash legs (ADR 0012, #509)", () => {
    let brokerage: string;
    let otherBrokerage: string;
    let portfolioId: string;
    let instrumentId: string;

    async function brokerageAccount(name: string): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, $2, 'brokerage', 'EUR', false) RETURNING id",
        [workspaceId, name],
      );
      return rows[0]!.id;
    }

    /** `createTrades` in a transaction of its own, as a request would run it. */
    async function trades(input: TradeEntryInput): Promise<TradeRecord[]> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const records = await createTrades(client, workspaceId, null, input);
        await client.query("COMMIT");
        return records;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    async function legOf(tradeId: string) {
      const { rows } = await pool.query<{ id: string; account_id: string; date: string; amount_cents: string }>(
        `SELECT t.id, t.account_id, to_char(t.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS date,
                (SELECT sum(amount_cents) FROM splits WHERE transaction_id = t.id) AS amount_cents
         FROM transactions t WHERE t.trade_id = $1`,
        [tradeId],
      );
      return rows[0];
    }

    before(async () => {
      brokerage = await brokerageAccount("Broker");
      otherBrokerage = await brokerageAccount("Other broker");
      const portfolio = await pool.query<{ id: string }>("INSERT INTO portfolios (workspace_id, name) VALUES ($1, 'Growth') RETURNING id", [
        workspaceId,
      ]);
      portfolioId = portfolio.rows[0]!.id;
      const instrument = await pool.query<{ id: string }>(
        `INSERT INTO instruments (ticker, exchange, name, type, currency) VALUES ($1, 'XMIL', 'Sync test', 'fund', 'EUR') RETURNING id`,
        [`S${randomUUID().slice(0, 8).toUpperCase()}`],
      );
      instrumentId = instrument.rows[0]!.id;
    });

    after(async () => {
      // The trades go first: the instrument cannot go while they reference it.
      await pool.query("DELETE FROM trades WHERE workspace_id = $1", [workspaceId]);
      await pool.query("DELETE FROM instruments WHERE id = $1", [instrumentId]);
    });

    it("locks a field of a trade whose cash leg is reconciled, or whose transfer's other leg's is", async () => {
      const [fee] = await trades({ kind: "single", type: "fee", accountId: brokerage, portfolioId, instrumentId: null, tradeDate: "2026-01-10", feesCents: 700 });
      assert.equal(await isLocked(pool, workspaceId, "trades.fees_cents", fee!.id), false);
      await reconcile(fee!.cashTransactionId!);
      assert.equal(await isLocked(pool, workspaceId, "trades.fees_cents", fee!.id), true);

      await trades({ kind: "single", type: "buy", accountId: brokerage, portfolioId, instrumentId, tradeDate: "2026-01-10", quantityE8: 10e8, priceE6: 1e6 });
      const legs = await trades({
        kind: "transfer",
        instrumentId,
        tradeDate: "2026-02-01",
        quantityE8: 5e8,
        from: { accountId: brokerage, portfolioId, feesCents: 900 },
        to: { accountId: otherBrokerage, portfolioId },
      });
      const outgoing = legs.find((leg) => leg.quantityE8 < 0)!;
      const incoming = legs.find((leg) => leg.quantityE8 > 0)!;
      assert.equal(incoming.cashTransactionId, null);
      assert.equal(await isLocked(pool, workspaceId, "trades.quantity_e8", incoming.id), false);
      await reconcile(outgoing.cashTransactionId!);
      assert.equal(await isLocked(pool, workspaceId, "trades.quantity_e8", outgoing.id), true);
      assert.equal(await isLocked(pool, workspaceId, "trades.quantity_e8", incoming.id), true);

      assert.equal(await isLocked(pool, workspaceId, "trades.memo", "not-a-uuid"), false);
      assert.equal(await isLocked(pool, workspaceId, "trades.memo", randomUUID()), false);
    });

    it("re-derives the cash leg's amount, account and date after an applied change to the trade", async () => {
      const [fee] = await trades({ kind: "single", type: "fee", accountId: brokerage, portfolioId, instrumentId: null, tradeDate: "2026-03-10", feesCents: 700 });
      // What a wired trades.* applier would do: change the trade's own columns, nothing else.
      await pool.query("UPDATE trades SET fees_cents = 900, trade_date = '2026-03-12', account_id = $2 WHERE id = $1", [fee!.id, otherBrokerage]);
      await afterApply(pool, workspaceId, "trades.fees_cents", fee!.id);
      assert.deepEqual({ ...(await legOf(fee!.id)) }, { id: fee!.cashTransactionId, account_id: otherBrokerage, date: "2026-03-12 00:00", amount_cents: "-900" });

      // A trade that starts moving cash gets a leg; one that stops loses it.
      const [transferOut] = await trades({ kind: "transfer", instrumentId, tradeDate: "2026-03-20", quantityE8: 1e8, from: { accountId: brokerage, portfolioId } });
      assert.equal(await legOf(transferOut!.id), undefined);
      await pool.query("UPDATE trades SET fees_cents = 300 WHERE id = $1", [transferOut!.id]);
      await afterApply(pool, workspaceId, "trades.fees_cents", transferOut!.id);
      assert.equal((await legOf(transferOut!.id))?.amount_cents, "-300");
      await pool.query("UPDATE trades SET fees_cents = 0 WHERE id = $1", [transferOut!.id]);
      await afterApply(pool, workspaceId, "trades.fees_cents", transferOut!.id);
      assert.equal(await legOf(transferOut!.id), undefined);
    });

    it("sends a cleared leg back to pending only when the applied change moves its amount, account or date", async () => {
      const [fee] = await trades({ kind: "single", type: "fee", accountId: brokerage, portfolioId, instrumentId: null, tradeDate: "2026-05-10", feesCents: 700 });
      const statusOf = async () =>
        (await pool.query<{ status: string }>("SELECT status FROM transactions WHERE id = $1", [fee!.cashTransactionId])).rows[0]!.status;
      const clear = () => pool.query("UPDATE transactions SET status = 'cleared' WHERE id = $1", [fee!.cashTransactionId]);

      // A change that leaves the leg as it is (the trade's memo).
      await clear();
      let before = await beforeApply(pool, workspaceId, "trades.memo", fee!.id);
      await pool.query("UPDATE trades SET memo = 'custody' WHERE id = $1", [fee!.id]);
      await afterApply(pool, workspaceId, "trades.memo", fee!.id, before);
      assert.equal(await statusOf(), "cleared");

      // A move to another account: the leg has followed through the foreign key already, so only
      // what beforeApply read tells it moved.
      before = await beforeApply(pool, workspaceId, "trades.account_id", fee!.id);
      assert.deepEqual(before, { tradeAccountId: brokerage });
      await pool.query("UPDATE trades SET account_id = $2 WHERE id = $1", [fee!.id, otherBrokerage]);
      await afterApply(pool, workspaceId, "trades.account_id", fee!.id, before);
      assert.equal(await statusOf(), "pending");

      // An amount change.
      await clear();
      before = await beforeApply(pool, workspaceId, "trades.fees_cents", fee!.id);
      await pool.query("UPDATE trades SET fees_cents = 800 WHERE id = $1", [fee!.id]);
      await afterApply(pool, workspaceId, "trades.fees_cents", fee!.id, before);
      assert.equal(await statusOf(), "pending");
    });

    it("has no trade field wired yet: a change to one is unsupported", async () => {
      const [fee] = await trades({ kind: "single", type: "fee", accountId: brokerage, portfolioId, instrumentId: null, tradeDate: "2026-04-10", feesCents: 700 });
      const outcome = await applyIncomingChange(pool, workspaceId, { id: randomUUID(), entityId: fee!.id, fieldName: "trades.fees_cents", hlc: hlc(1000), value: 1 });
      assert.equal(outcome, "unsupported_field");
    });
  });
});
