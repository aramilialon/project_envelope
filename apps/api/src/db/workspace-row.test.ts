import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "./migrate.ts";
import { createPool, type DbPool } from "./pool.ts";
import { workspaceRowExists, type WorkspaceTable } from "./workspace-row.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("workspaceRowExists (#513)", () => {
  let pool: DbPool;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let accountId: string;
  let transactionId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Mine', 'EUR', 'UTC'), ($2, 'Other', 'EUR', 'UTC')",
      [workspaceId, otherWorkspaceId],
    );
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    accountId = account.rows[0]!.id;
    const transaction = await pool.query<{ id: string }>(
      "INSERT INTO transactions (workspace_id, account_id, occurred_at, status) VALUES ($1, $2, now(), 'pending') RETURNING id",
      [workspaceId, accountId],
    );
    transactionId = transaction.rows[0]!.id;
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[workspaceId, otherWorkspaceId]]);
    await pool.end();
  });

  it("finds a row of the workspace, in the table named", async () => {
    assert.equal(await workspaceRowExists(pool, "transactions", workspaceId, transactionId), true);
    assert.equal(await workspaceRowExists(pool, "accounts", workspaceId, accountId), true);
    assert.equal(await workspaceRowExists(pool, "accounts", workspaceId, transactionId), false);
  });

  it("answers another workspace's row, a uuid naming nothing and a malformed id alike", async () => {
    assert.equal(await workspaceRowExists(pool, "transactions", otherWorkspaceId, transactionId), false);
    assert.equal(await workspaceRowExists(pool, "transactions", workspaceId, randomUUID()), false);
    assert.equal(await workspaceRowExists(pool, "transactions", workspaceId, "not-a-uuid"), false);
  });

  it("refuses a table outside its allowlist", async () => {
    await assert.rejects(workspaceRowExists(pool, "users" as WorkspaceTable, workspaceId, randomUUID()), /allowlist/);
    await assert.rejects(workspaceRowExists(pool, "toString" as WorkspaceTable, workspaceId, randomUUID()), /allowlist/);
  });
});
