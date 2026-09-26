import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { recordAuditLog } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("recordAuditLog", () => {
  let pool: DbPool;
  let workspaceId: string;
  let userId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    workspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'Europe/Rome')", [
      workspaceId,
    ]);
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id",
      [randomUUID(), `${randomUUID()}@example.com`],
    );
    userId = rows[0]!.id;
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await pool.end();
  });

  it("records the actor, the action and the before/after state", async () => {
    await recordAuditLog(pool, {
      workspaceId,
      userId,
      action: "reconciliation.unlock",
      before: { reconciledAt: "2026-01-01T00:00:00Z" },
      after: null,
    });

    const { rows } = await pool.query(
      "SELECT workspace_id, user_id, action, before, after FROM audit_log WHERE workspace_id = $1",
      [workspaceId],
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      workspace_id: workspaceId,
      user_id: userId,
      action: "reconciliation.unlock",
      before: { reconciledAt: "2026-01-01T00:00:00Z" },
      after: null,
    });
  });

  it("allows a null actor, for system-initiated actions", async () => {
    await recordAuditLog(pool, { workspaceId, userId: null, action: "system.something", before: null, after: null });

    const { rows } = await pool.query<{ user_id: string | null }>(
      "SELECT user_id FROM audit_log WHERE workspace_id = $1 AND action = 'system.something'",
      [workspaceId],
    );
    assert.equal(rows[0]?.user_id, null);
  });
});
