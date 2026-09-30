import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Hlc } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { createTransaction } from "../transactions/repository.ts";
import { applyIncomingChange } from "./apply.ts";

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
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.end();
  });

  async function createTestTransaction(): Promise<string> {
    const tx = await createTransaction(pool, {
      workspaceId,
      accountId,
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
});
