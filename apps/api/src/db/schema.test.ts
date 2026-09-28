import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "./migrate.ts";
import { createPool, type DbPool } from "./pool.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

const WORKSPACE_TABLES = [
  "workspaces",
  "memberships",
  "accounts",
  "category_groups",
  "categories",
  "transactions",
  "splits",
  "assignment_ledger",
  "audit_log",
];

describe("apps/api/migrations, applied to a real database", () => {
  let pool: DbPool;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
  });

  after(async () => {
    await pool.end();
  });

  it("creates every expected table", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tableNames = new Set(rows.map((row) => row.table_name));
    for (const expected of ["users", ...WORKSPACE_TABLES]) {
      assert.ok(tableNames.has(expected), `expected table "${expected}" to exist`);
    }
  });

  it("forces row-level security on every workspace-scoped table", async () => {
    const { rows } = await pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class
       WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity`,
      [WORKSPACE_TABLES],
    );
    assert.deepEqual(
      new Set(rows.map((row) => row.relname)),
      new Set(WORKSPACE_TABLES),
    );
  });

  describe("row-level security, as the envelope_app role", () => {
    let workspaceA: string;
    let workspaceB: string;

    before(async () => {
      workspaceA = randomUUID();
      workspaceB = randomUUID();
      await pool.query(
        "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Workspace A', 'EUR', 'Europe/Rome'), ($2, 'Workspace B', 'EUR', 'Europe/Rome')",
        [workspaceA, workspaceB],
      );
      await pool.query(
        "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking A', 'checking', 'EUR'), ($2, 'Checking B', 'checking', 'EUR')",
        [workspaceA, workspaceB],
      );
    });

    it("only shows the selected workspace's rows", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE envelope_app");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceA]);

        const workspaces = await client.query("SELECT name FROM workspaces");
        const accounts = await client.query("SELECT name FROM accounts");

        assert.deepEqual(workspaces.rows, [{ name: "Workspace A" }]);
        assert.deepEqual(accounts.rows, [{ name: "Checking A" }]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("shows nothing when no workspace is selected", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE envelope_app");

        const workspaces = await client.query("SELECT name FROM workspaces");
        const accounts = await client.query("SELECT name FROM accounts");

        assert.deepEqual(workspaces.rows, []);
        assert.deepEqual(accounts.rows, []);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("does not let envelope_app write rows outside the selected workspace", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE envelope_app");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceA]);

        await assert.rejects(
          () =>
            client.query("INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Sneaky', 'cash', 'EUR')", [
              workspaceB,
            ]),
          /row-level security/,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });

  describe("audit_log is append-only", () => {
    let workspaceId: string;
    let entryId: string;

    before(async () => {
      workspaceId = randomUUID();
      await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Audited', 'EUR', 'Europe/Rome')", [
        workspaceId,
      ]);
      const { rows } = await pool.query<{ id: string }>(
        "INSERT INTO audit_log (workspace_id, user_id, action) VALUES ($1, NULL, 'test.action') RETURNING id",
        [workspaceId],
      );
      entryId = rows[0]!.id;
    });

    it("rejects an UPDATE from envelope_app", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE envelope_app");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);

        await assert.rejects(
          () => client.query("UPDATE audit_log SET action = 'changed' WHERE id = $1", [entryId]),
          /permission denied/,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("rejects a DELETE from envelope_app", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE envelope_app");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);

        await assert.rejects(
          () => client.query("DELETE FROM audit_log WHERE id = $1", [entryId]),
          /permission denied/,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });

  describe("assignment_ledger is append-only", () => {
    let workspaceId: string;
    let userId: string;
    let categoryId: string;
    let entryId: string;

    before(async () => {
      workspaceId = randomUUID();
      await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Assigned', 'EUR', 'Europe/Rome')", [
        workspaceId,
      ]);
      const user = await pool.query<{ id: string }>(
        "INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id",
        [randomUUID(), `${randomUUID()}@example.com`],
      );
      userId = user.rows[0]!.id;
      const group = await pool.query<{ id: string }>(
        "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
        [workspaceId],
      );
      const category = await pool.query<{ id: string }>(
        "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
        [workspaceId, group.rows[0]!.id],
      );
      categoryId = category.rows[0]!.id;
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO assignment_ledger (batch_id, workspace_id, month, destination_category_id, amount_cents, author)
         VALUES ($1, $2, '2026-09-01', $3, 1000, $4) RETURNING id`,
        [randomUUID(), workspaceId, categoryId, userId],
      );
      entryId = rows[0]!.id;
    });

    it("rejects an UPDATE from envelope_app", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE envelope_app");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);

        await assert.rejects(
          () => client.query("UPDATE assignment_ledger SET amount_cents = 2000 WHERE id = $1", [entryId]),
          /permission denied/,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("rejects a DELETE from envelope_app", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE envelope_app");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);

        await assert.rejects(
          () => client.query("DELETE FROM assignment_ledger WHERE id = $1", [entryId]),
          /permission denied/,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });
});
