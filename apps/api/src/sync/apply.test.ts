import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Hlc } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { createTransaction } from "../transactions/repository.ts";
import { applyIncomingChange, type IncomingChange } from "./apply.ts";

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
});
