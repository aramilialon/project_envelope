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
  "monthly_assignments",
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
});
