import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { isPortfolioNameConflict } from "../portfolios/repository.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "./migrate.ts";
import { createPool, type DbClient, type DbPool } from "./pool.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

const EXPECTED_TABLES = [
  "users",
  "workspaces",
  "memberships",
  "accounts",
  "category_groups",
  "categories",
  "transactions",
  "splits",
  "assignment_ledger",
  "audit_log",
  "goals",
  "import_mappings",
  "staged_transactions",
  "reconciliations",
  "processed_jobs",
  "device_tokens",
  "notification_deliveries",
  "notified_budget_problems",
  "change_log",
  "scheduled_transactions",
  "scheduled_transaction_splits",
  "trades",
  "prices",
];

/**
 * Every workspace-scoped table, read from the schema itself rather than kept by hand: each table
 * with a `workspace_id` column, plus `workspaces`, scoped by its own `id`. A new table therefore
 * cannot be forgotten by the Row-Level Security check below. No table with a `workspace_id`
 * column is exempt from Row-Level Security today.
 */
async function loadWorkspaceTables(pool: DbPool): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'workspace_id'`,
  );
  return ["workspaces", ...rows.map((row) => row.table_name)].sort();
}

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
    for (const expected of EXPECTED_TABLES) {
      assert.ok(tableNames.has(expected), `expected table "${expected}" to exist`);
    }
  });

  it("forces row-level security on every workspace-scoped table", async () => {
    const workspaceTables = await loadWorkspaceTables(pool);
    // Guards against the query above silently returning nothing, which would make this test pass vacuously.
    for (const known of ["accounts", "transactions", "splits", "reconciliations", "goals", "change_log", "portfolios", "trades", "prices", "instruments"]) {
      assert.ok(workspaceTables.includes(known), `expected "${known}" among the workspace-scoped tables`);
    }

    const { rows } = await pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)
         AND relrowsecurity AND relforcerowsecurity
         AND EXISTS (SELECT FROM pg_policy WHERE polrelid = pg_class.oid)`,
      [workspaceTables],
    );
    assert.deepEqual(rows.map((row) => row.relname).sort(), workspaceTables);
  });

  it("makes every foreign key between two workspace-scoped tables composite on workspace_id", async () => {
    // A foreign key is checked without Row-Level Security, so one on the id alone would let a
    // row reference another workspace's row (ADR 0006). Both sides carry workspace_id: the key
    // must pair the two workspace_id columns, as migration 0029 does.
    const { rows } = await pool.query<{ conname: string; composite: boolean }>(
      `SELECT c.conname,
              EXISTS (
                SELECT FROM unnest(c.conkey, c.confkey) AS k (child, parent)
                WHERE k.child = child_ws.attnum AND k.parent = parent_ws.attnum
              ) AS composite
       FROM pg_constraint c
       JOIN pg_attribute child_ws ON child_ws.attrelid = c.conrelid AND child_ws.attname = 'workspace_id'
       JOIN pg_attribute parent_ws ON parent_ws.attrelid = c.confrelid AND parent_ws.attname = 'workspace_id'
       WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`,
    );
    assert.ok(rows.length >= 19, `expected at least 19 workspace-to-workspace foreign keys, found ${rows.length}`);
    // The only exceptions point at `instruments`, whose workspace_id is null for the shared catalog
    // (migration 0035, #505): a composite key cannot say "shared, or this row's own workspace's",
    // so a trigger reading the instrument under the caller's policies guards each of them instead
    // (checked below, and exercised in private-instruments.test.ts).
    const guardedByTrigger: Readonly<Record<string, string>> = {
      prices_instrument_id_fkey: "prices_refuse_hidden_instrument",
      trades_instrument_id_fkey: "trades_refuse_hidden_instrument",
    };
    assert.deepEqual(
      rows
        .filter((row) => !row.composite)
        .map((row) => row.conname)
        .sort(),
      Object.keys(guardedByTrigger).sort(),
    );
    const { rows: triggers } = await pool.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger WHERE tgname = ANY($1) AND tgenabled = 'O'",
      [Object.values(guardedByTrigger)],
    );
    assert.deepEqual(triggers.map((row) => row.tgname).sort(), Object.values(guardedByTrigger).sort());
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

  describe("foreign keys cannot cross workspaces, as the envelope_app role", () => {
    interface WorkspaceRows {
      readonly workspaceId: string;
      readonly groupId: string;
      readonly categoryId: string;
      readonly accountId: string;
      readonly transactionId: string;
      readonly reconciliationId: string;
      readonly ledgerEntryId: string;
      readonly scheduledTransactionId: string;
    }

    let userId: string;
    let workspaceA: WorkspaceRows;
    let workspaceB: WorkspaceRows;

    // Created as the migrating superuser, so both workspaces exist before envelope_app,
    // restricted to workspace A, tries to point at workspace B's rows.
    async function createWorkspaceRows(name: string): Promise<WorkspaceRows> {
      const workspaceId = randomUUID();
      await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, $2, 'EUR', 'Europe/Rome')", [
        workspaceId,
        name,
      ]);
      const insertId = async (sql: string, params: unknown[]): Promise<string> => {
        const { rows } = await pool.query<{ id: string }>(`${sql} RETURNING id`, params);
        return rows[0]!.id;
      };
      const groupId = await insertId(
        "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1)",
        [workspaceId],
      );
      const categoryId = await insertId(
        "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1)",
        [workspaceId, groupId],
      );
      const accountId = await insertId(
        "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR')",
        [workspaceId],
      );
      const transactionId = await insertId(
        "INSERT INTO transactions (workspace_id, account_id, occurred_at, status) VALUES ($1, $2, now(), 'cleared')",
        [workspaceId, accountId],
      );
      const reconciliationId = await insertId(
        "INSERT INTO reconciliations (workspace_id, account_id, reconciled_at, statement_balance_cents) VALUES ($1, $2, '2026-09-30', 0)",
        [workspaceId, accountId],
      );
      const ledgerEntryId = await insertId(
        `INSERT INTO assignment_ledger (batch_id, workspace_id, month, destination_category_id, amount_cents, author)
         VALUES ($1, $2, '2026-09-01', $3, 1000, $4)`,
        [randomUUID(), workspaceId, categoryId, userId],
      );
      const scheduledTransactionId = await insertId(
        `INSERT INTO scheduled_transactions (workspace_id, account_id, next_due_date, recur_every, recur_unit)
         VALUES ($1, $2, '2026-10-01', 1, 'month')`,
        [workspaceId, accountId],
      );
      return {
        workspaceId,
        groupId,
        categoryId,
        accountId,
        transactionId,
        reconciliationId,
        ledgerEntryId,
        scheduledTransactionId,
      };
    }

    before(async () => {
      const user = await pool.query<{ id: string }>(
        "INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id",
        [randomUUID(), `${randomUUID()}@example.com`],
      );
      userId = user.rows[0]!.id;
      workspaceA = await createWorkspaceRows("Workspace A");
      workspaceB = await createWorkspaceRows("Workspace B");
    });

    // The scheduled-transactions job (#38) works through every workspace in the database, so an
    // overdue scheduled transaction left behind here would fail its tests.
    after(async () => {
      const workspaceIds = [workspaceA.workspaceId, workspaceB.workspaceId];
      await pool.query("DELETE FROM assignment_ledger WHERE workspace_id = ANY($1)", [workspaceIds]);
      await pool.query("DELETE FROM workspaces WHERE id = ANY($1)", [workspaceIds]);
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    });

    /**
     * One insert per composite foreign key of migration 0029, always into workspace A, pointing at
     * `target`'s row: workspace A's own (which must work) or workspace B's (which must not).
     */
    const cases: ReadonlyArray<{
      readonly constraint: string;
      readonly insert: (target: WorkspaceRows) => readonly [string, unknown[]];
    }> = [
      {
        constraint: "categories_group_id_fkey",
        insert: (t) => [
          "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Rent', 2)",
          [workspaceA.workspaceId, t.groupId],
        ],
      },
      {
        constraint: "accounts_payment_category_id_fkey",
        insert: (t) => [
          "INSERT INTO accounts (workspace_id, name, type, currency, payment_category_id) VALUES ($1, 'Card', 'credit_card', 'EUR', $2)",
          [workspaceA.workspaceId, t.categoryId],
        ],
      },
      {
        constraint: "transactions_account_id_fkey",
        insert: (t) => [
          "INSERT INTO transactions (workspace_id, account_id, occurred_at, status) VALUES ($1, $2, now(), 'cleared')",
          [workspaceA.workspaceId, t.accountId],
        ],
      },
      {
        constraint: "transactions_transfer_id_fkey",
        insert: (t) => [
          "INSERT INTO transactions (workspace_id, account_id, occurred_at, status, transfer_id) VALUES ($1, $2, now(), 'cleared', $3)",
          [workspaceA.workspaceId, workspaceA.accountId, t.transactionId],
        ],
      },
      {
        constraint: "transactions_reconciliation_id_fkey",
        insert: (t) => [
          "INSERT INTO transactions (workspace_id, account_id, occurred_at, status, reconciliation_id) VALUES ($1, $2, now(), 'reconciled', $3)",
          [workspaceA.workspaceId, workspaceA.accountId, t.reconciliationId],
        ],
      },
      {
        constraint: "splits_transaction_id_fkey",
        insert: (t) => [
          "INSERT INTO splits (workspace_id, transaction_id, category_id, amount_cents) VALUES ($1, $2, $3, -500)",
          [workspaceA.workspaceId, t.transactionId, workspaceA.categoryId],
        ],
      },
      {
        constraint: "splits_category_id_fkey",
        insert: (t) => [
          "INSERT INTO splits (workspace_id, transaction_id, category_id, amount_cents) VALUES ($1, $2, $3, -500)",
          [workspaceA.workspaceId, workspaceA.transactionId, t.categoryId],
        ],
      },
      {
        constraint: "assignment_ledger_source_category_id_fkey",
        insert: (t) => [
          `INSERT INTO assignment_ledger (batch_id, workspace_id, month, source_category_id, amount_cents, author)
           VALUES ($1, $2, '2026-09-01', $3, 100, $4)`,
          [randomUUID(), workspaceA.workspaceId, t.categoryId, userId],
        ],
      },
      {
        constraint: "assignment_ledger_destination_category_id_fkey",
        insert: (t) => [
          `INSERT INTO assignment_ledger (batch_id, workspace_id, month, destination_category_id, amount_cents, author)
           VALUES ($1, $2, '2026-09-01', $3, 100, $4)`,
          [randomUUID(), workspaceA.workspaceId, t.categoryId, userId],
        ],
      },
      {
        constraint: "assignment_ledger_reverses_fkey",
        insert: (t) => [
          `INSERT INTO assignment_ledger (batch_id, workspace_id, month, source_category_id, amount_cents, author, reverses)
           VALUES ($1, $2, '2026-09-01', $3, 1000, $4, $5)`,
          [randomUUID(), workspaceA.workspaceId, workspaceA.categoryId, userId, t.ledgerEntryId],
        ],
      },
      {
        constraint: "goals_category_id_fkey",
        insert: (t) => [
          "INSERT INTO goals (workspace_id, category_id, kind, amount_cents) VALUES ($1, $2, 'monthly', 1000)",
          [workspaceA.workspaceId, t.categoryId],
        ],
      },
      {
        constraint: "import_mappings_account_id_fkey",
        insert: (t) => [
          "INSERT INTO import_mappings (account_id, workspace_id, mapping) VALUES ($1, $2, '{}')",
          [t.accountId, workspaceA.workspaceId],
        ],
      },
      {
        constraint: "staged_transactions_account_id_fkey",
        insert: (t) => [
          "INSERT INTO staged_transactions (workspace_id, account_id, occurred_at, amount_cents) VALUES ($1, $2, '2026-09-15', -500)",
          [workspaceA.workspaceId, t.accountId],
        ],
      },
      {
        constraint: "staged_transactions_duplicate_of_fkey",
        insert: (t) => [
          "INSERT INTO staged_transactions (workspace_id, account_id, occurred_at, amount_cents, duplicate_of) VALUES ($1, $2, '2026-09-15', -500, $3)",
          [workspaceA.workspaceId, workspaceA.accountId, t.transactionId],
        ],
      },
      {
        constraint: "reconciliations_account_id_fkey",
        insert: (t) => [
          "INSERT INTO reconciliations (workspace_id, account_id, reconciled_at, statement_balance_cents) VALUES ($1, $2, '2026-10-31', 0)",
          [workspaceA.workspaceId, t.accountId],
        ],
      },
      {
        constraint: "notified_budget_problems_category_id_fkey",
        insert: (t) => [
          "INSERT INTO notified_budget_problems (workspace_id, month, kind, category_id, amount_cents) VALUES ($1, '2026-09-01', 'overspent_category', $2, 500)",
          [workspaceA.workspaceId, t.categoryId],
        ],
      },
      {
        constraint: "scheduled_transactions_account_id_fkey",
        insert: (t) => [
          `INSERT INTO scheduled_transactions (workspace_id, account_id, next_due_date, recur_every, recur_unit)
           VALUES ($1, $2, '2026-10-01', 1, 'month')`,
          [workspaceA.workspaceId, t.accountId],
        ],
      },
      {
        constraint: "scheduled_transaction_splits_scheduled_transaction_id_fkey",
        insert: (t) => [
          "INSERT INTO scheduled_transaction_splits (workspace_id, scheduled_transaction_id, category_id, amount_cents) VALUES ($1, $2, $3, 500)",
          [workspaceA.workspaceId, t.scheduledTransactionId, workspaceA.categoryId],
        ],
      },
      {
        constraint: "scheduled_transaction_splits_category_id_fkey",
        insert: (t) => [
          "INSERT INTO scheduled_transaction_splits (workspace_id, scheduled_transaction_id, category_id, amount_cents) VALUES ($1, $2, $3, 500)",
          [workspaceA.workspaceId, workspaceA.scheduledTransactionId, t.categoryId],
        ],
      },
    ];

    async function insertAsAppInWorkspaceA(sql: string, params: unknown[]): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE envelope_app");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceA.workspaceId]);
        await client.query(sql, params);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }

    for (const { constraint, insert } of cases) {
      it(`${constraint}: accepts workspace A's own row and rejects workspace B's`, async () => {
        // The control: the same insert pointing at workspace A's row succeeds, so the rejection
        // below comes from the foreign key and nothing else.
        await insertAsAppInWorkspaceA(...insert(workspaceA));

        await assert.rejects(
          () => insertAsAppInWorkspaceA(...insert(workspaceB)),
          (error: { code?: string; constraint?: string }) => {
            assert.equal(error.code, "23503", `expected a foreign key violation, got ${String(error.code)}`);
            assert.equal(error.constraint, constraint);
            return true;
          },
        );
      });
    }

    it("still clears only the id, never workspace_id, when a SET NULL reference is deleted", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE envelope_app");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceA.workspaceId]);
        const partner = await client.query<{ id: string }>(
          `INSERT INTO transactions (workspace_id, account_id, occurred_at, status, transfer_id, reconciliation_id)
           VALUES ($1, $2, now(), 'reconciled', $3, $4) RETURNING id`,
          [workspaceA.workspaceId, workspaceA.accountId, workspaceA.transactionId, workspaceA.reconciliationId],
        );
        const staged = await client.query<{ id: string }>(
          `INSERT INTO staged_transactions (workspace_id, account_id, occurred_at, amount_cents, duplicate_of)
           VALUES ($1, $2, '2026-09-15', -500, $3) RETURNING id`,
          [workspaceA.workspaceId, workspaceA.accountId, workspaceA.transactionId],
        );

        // envelope_app may not delete a reconciliation (migration 0015), so the deletes run as the owner.
        await client.query("RESET ROLE");
        await client.query("DELETE FROM transactions WHERE id = $1", [workspaceA.transactionId]);
        await client.query("DELETE FROM reconciliations WHERE id = $1", [workspaceA.reconciliationId]);

        const partnerAfter = await client.query("SELECT workspace_id, transfer_id, reconciliation_id FROM transactions WHERE id = $1", [
          partner.rows[0]!.id,
        ]);
        assert.deepEqual(partnerAfter.rows, [
          { workspace_id: workspaceA.workspaceId, transfer_id: null, reconciliation_id: null },
        ]);
        const stagedAfter = await client.query("SELECT workspace_id, duplicate_of FROM staged_transactions WHERE id = $1", [
          staged.rows[0]!.id,
        ]);
        assert.deepEqual(stagedAfter.rows, [{ workspace_id: workspaceA.workspaceId, duplicate_of: null }]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("names only foreign keys that exist", async () => {
      // A renamed or dropped constraint must not leave a case above testing nothing. Foreign keys
      // added by later migrations are covered by the catalog check at the top of this file.
      const { rows } = await pool.query<{ conname: string }>(
        "SELECT conname FROM pg_constraint WHERE contype = 'f' AND conname = ANY($1)",
        [cases.map((testCase) => testCase.constraint)],
      );
      assert.equal(rows.length, cases.length);
    });
  });

  describe("portfolios (#75), as the envelope_app role", () => {
    let workspaceA: string;
    let workspaceB: string;
    let portfolioB: string;

    before(async () => {
      workspaceA = randomUUID();
      workspaceB = randomUUID();
      await pool.query(
        "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Portfolios A', 'EUR', 'Europe/Rome'), ($2, 'Portfolios B', 'EUR', 'Europe/Rome')",
        [workspaceA, workspaceB],
      );
      await pool.query("INSERT INTO portfolios (workspace_id, name) VALUES ($1, 'Growth A')", [workspaceA]);
      const { rows } = await pool.query<{ id: string }>(
        "INSERT INTO portfolios (workspace_id, name) VALUES ($1, 'Growth B') RETURNING id",
        [workspaceB],
      );
      portfolioB = rows[0]!.id;
    });

    after(async () => {
      await pool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[workspaceA, workspaceB]]);
    });

    async function asWorkspaceA<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE envelope_app");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceA]);
        return await fn(client);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }

    it("only shows, updates and deletes the selected workspace's portfolios", async () => {
      await asWorkspaceA(async (client) => {
        const visible = await client.query("SELECT name FROM portfolios");
        assert.deepEqual(visible.rows, [{ name: "Growth A" }]);

        const updated = await client.query("UPDATE portfolios SET name = 'Taken over' WHERE id = $1", [portfolioB]);
        assert.equal(updated.rowCount, 0);
        const deleted = await client.query("DELETE FROM portfolios WHERE id = $1", [portfolioB]);
        assert.equal(deleted.rowCount, 0);
      });
      const untouched = await pool.query("SELECT name FROM portfolios WHERE id = $1", [portfolioB]);
      assert.deepEqual(untouched.rows, [{ name: "Growth B" }]);
    });

    it("does not let envelope_app insert a portfolio into another workspace", async () => {
      await asWorkspaceA(async (client) => {
        await assert.rejects(
          () => client.query("INSERT INTO portfolios (workspace_id, name) VALUES ($1, 'Sneaky')", [workspaceB]),
          /row-level security/,
        );
      });
    });

    it("refuses a second non-archived portfolio with the same name, ignoring case and spaces, but not an archived one", async () => {
      await asWorkspaceA(async (client) => {
        await assert.rejects(
          () => client.query("INSERT INTO portfolios (workspace_id, name) VALUES ($1, ' growth a ')", [workspaceA]),
          (error: unknown) => {
            // The exact fields routes/portfolios.ts relies on to answer 409 name_taken for a race.
            const { code, constraint } = error as { code?: unknown; constraint?: unknown };
            assert.equal(code, "23505");
            assert.equal(constraint, "portfolios_active_name_idx");
            assert.equal(isPortfolioNameConflict(error), true);
            return true;
          },
        );
      });
      await asWorkspaceA(async (client) => {
        await client.query("INSERT INTO portfolios (workspace_id, name, archived_at) VALUES ($1, 'GROWTH A', now())", [workspaceA]);
      });
    });
  });

  describe("tax regimes of brokerage accounts (#508), as the envelope_app role", () => {
    let workspaceA: string;
    let workspaceB: string;
    let brokerageA: string;
    let checkingA: string;
    let brokerageB: string;

    /** Runs `body` as envelope_app with workspace `workspaceId` selected, always rolled back. */
    async function asApp(workspaceId: string, body: (client: DbClient) => Promise<void>): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE envelope_app");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        await body(client);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }

    /** Asserts `query` fails as a violation of the named constraint, with the given SQLSTATE. */
    async function rejectsWith(query: Promise<unknown>, code: string, constraint: string): Promise<void> {
      await assert.rejects(query, (error: { code?: string; constraint?: string }) => {
        assert.equal(error.code, code);
        assert.equal(error.constraint, constraint);
        return true;
      });
    }

    before(async () => {
      workspaceA = randomUUID();
      workspaceB = randomUUID();
      await pool.query(
        "INSERT INTO workspaces (id, name, base_currency, time_zone, tax_country) VALUES ($1, 'Taxed A', 'EUR', 'Europe/Rome', 'IT'), ($2, 'Taxed B', 'EUR', 'Europe/Rome', 'IT')",
        [workspaceA, workspaceB],
      );
      const accounts = await pool.query<{ id: string; name: string }>(
        `INSERT INTO accounts (workspace_id, name, type, currency, on_budget, domestic_withholding_agent)
         VALUES ($1, 'Broker A', 'brokerage', 'EUR', false, true), ($1, 'Checking A', 'checking', 'EUR', true, NULL),
                ($2, 'Broker B', 'brokerage', 'EUR', false, false)
         RETURNING id, name`,
        [workspaceA, workspaceB],
      );
      const idOf = (name: string) => accounts.rows.find((row) => row.name === name)!.id;
      brokerageA = idOf("Broker A");
      checkingA = idOf("Checking A");
      brokerageB = idOf("Broker B");
      await pool.query(
        "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2024-03-15', 'administered'), ($3, $4, '2025-06-01', 'self_declared')",
        [workspaceA, brokerageA, workspaceB, brokerageB],
      );
    });

    it("only shows the selected workspace's regimes", async () => {
      await asApp(workspaceA, async (client) => {
        const { rows } = await client.query("SELECT account_id FROM account_tax_regimes");
        assert.deepEqual(rows, [{ account_id: brokerageA }]);
      });
    });

    it("does not let envelope_app insert a regime for another workspace", async () => {
      await asApp(workspaceA, async (client) => {
        await assert.rejects(
          client.query(
            "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2027-01-01', 'managed')",
            [workspaceB, brokerageB],
          ),
          /row-level security/,
        );
      });
    });

    it("keeps a regime in its account's own workspace (composite foreign key)", async () => {
      await rejectsWith(
        pool.query(
          "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2027-01-01', 'managed')",
          [workspaceA, brokerageB],
        ),
        "23503",
        "account_tax_regimes_account_fkey",
      );
    });

    it("accepts a change on 1 January, and rejects one on any other day", async () => {
      await asApp(workspaceA, async (client) => {
        await client.query(
          "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2027-01-01', 'self_declared')",
          [workspaceA, brokerageA],
        );
        await rejectsWith(
          client.query(
            "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2028-07-01', 'managed')",
            [workspaceA, brokerageA],
          ),
          "23514",
          "account_tax_regimes_year_start_check",
        );
      });
    });

    it("rejects an entry before a first one that does not start on 1 January", async () => {
      await asApp(workspaceA, async (client) => {
        await rejectsWith(
          client.query(
            "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2023-01-01', 'managed')",
            [workspaceA, brokerageA],
          ),
          "23514",
          "account_tax_regimes_year_start_check",
        );
      });
    });

    it("rejects two regimes on the same date", async () => {
      await asApp(workspaceA, async (client) => {
        await rejectsWith(
          client.query(
            "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2024-03-15', 'managed')",
            [workspaceA, brokerageA],
          ),
          "23505",
          "account_tax_regimes_pkey",
        );
      });
    });

    it("rejects a regime on an account that is not a brokerage account", async () => {
      await asApp(workspaceA, async (client) => {
        await rejectsWith(
          client.query(
            "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2026-05-05', 'managed')",
            [workspaceA, checkingA],
          ),
          "23514",
          "account_tax_regimes_brokerage_check",
        );
      });
    });

    it("rejects an unknown regime", async () => {
      await asApp(workspaceA, async (client) => {
        await rejectsWith(
          client.query(
            "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2030-01-01', 'other')",
            [workspaceA, brokerageA],
          ),
          "23514",
          "account_tax_regimes_regime_check",
        );
      });
    });

    it("gives envelope_app no UPDATE on a regime: a change is a new row", async () => {
      await asApp(workspaceA, async (client) => {
        await assert.rejects(
          client.query("UPDATE account_tax_regimes SET regime = 'managed' WHERE account_id = $1", [brokerageA]),
          /permission denied/,
        );
      });
    });

    it("rejects a withholding-agent flag on an account that is not a brokerage account", async () => {
      await asApp(workspaceA, async (client) => {
        await rejectsWith(
          client.query(
            "INSERT INTO accounts (workspace_id, name, type, currency, domestic_withholding_agent) VALUES ($1, 'Flagged', 'checking', 'EUR', true)",
            [workspaceA],
          ),
          "23514",
          "accounts_withholding_agent_brokerage_check",
        );
      });
    });

    it("keeps the workspace tax country to two capital letters", async () => {
      await asApp(workspaceA, async (client) => {
        await rejectsWith(
          client.query("UPDATE workspaces SET tax_country = 'ita' WHERE id = $1", [workspaceA]),
          "23514",
          "workspaces_tax_country_check",
        );
      });
    });

    it("rejects an administered or managed regime on an account whose broker is not an Italian withholding agent", async () => {
      for (const regime of ["administered", "managed"]) {
        await asApp(workspaceB, async (client) => {
          await rejectsWith(
            client.query(
              "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2026-01-01', $3)",
              [workspaceB, brokerageB, regime],
            ),
            "23514",
            "account_tax_regimes_withholding_agent_check",
          );
        });
      }
    });

    it("sets a withholding-agent flag once, then keeps it fixed", async () => {
      await asApp(workspaceA, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'No flag yet', 'brokerage', 'EUR', false) RETURNING id",
          [workspaceA],
        );
        await client.query("UPDATE accounts SET domestic_withholding_agent = true WHERE id = $1", [rows[0]!.id]);
        await rejectsWith(
          client.query("UPDATE accounts SET domestic_withholding_agent = false WHERE id = $1", [rows[0]!.id]),
          "23514",
          "accounts_withholding_agent_fixed_check",
        );
      });
    });

    it("accepts a new row before a first row dated 1 January", async () => {
      await asApp(workspaceA, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "INSERT INTO accounts (workspace_id, name, type, currency, on_budget, domestic_withholding_agent) VALUES ($1, 'Since January', 'brokerage', 'EUR', false, true) RETURNING id",
          [workspaceA],
        );
        const accountId = rows[0]!.id;
        await client.query(
          "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2025-01-01', 'administered')",
          [workspaceA, accountId],
        );
        await client.query(
          "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2019-03-03', 'self_declared')",
          [workspaceA, accountId],
        );
        const history = await client.query("SELECT regime FROM account_tax_regimes WHERE account_id = $1 ORDER BY valid_from", [accountId]);
        assert.deepEqual(history.rows, [{ regime: "self_declared" }, { regime: "administered" }]);
      });
    });

    it("makes a second concurrent first period wait for the first, then rejects it", async () => {
      const { rows } = await pool.query<{ id: string }>(
        "INSERT INTO accounts (workspace_id, name, type, currency, on_budget, domestic_withholding_agent) VALUES ($1, 'Raced', 'brokerage', 'EUR', false, false) RETURNING id",
        [workspaceA],
      );
      const accountId = rows[0]!.id;
      const first = await pool.connect();
      const second = await pool.connect();
      const insert = "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, $3, 'self_declared')";
      try {
        for (const client of [first, second]) {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE envelope_app");
          await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceA]);
        }
        const secondPid = (await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;

        await first.query(insert, [workspaceA, accountId, "2025-06-01"]);
        const secondInsert = second.query(insert, [workspaceA, accountId, "2025-07-01"]).then(
          () => undefined,
          (error: unknown) => error,
        );

        // The second insert waits on the account row the first one's trigger locked.
        for (let attempt = 0; ; attempt++) {
          const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [secondPid]);
          if (waiting.rows.length > 0) {
            break;
          }
          assert.ok(attempt < 100, "expected the second insert to wait for the account lock");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        await first.query("COMMIT");
        const error = (await secondInsert) as { code?: string; constraint?: string } | undefined;
        assert.equal(error?.code, "23514");
        assert.equal(error?.constraint, "account_tax_regimes_year_start_check");
      } finally {
        await first.query("ROLLBACK").catch(() => undefined);
        await second.query("ROLLBACK").catch(() => undefined);
        first.release();
        second.release();
        await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
      }
    });
  });

  describe("trades (#77), as the envelope_app role", () => {
    interface TradeRows {
      readonly workspaceId: string;
      readonly accountId: string;
      readonly portfolioId: string;
      readonly tradeId: string;
    }

    let instrumentId: string;
    let workspaceA: TradeRows;
    let workspaceB: TradeRows;

    async function createTradeRows(name: string): Promise<TradeRows> {
      const workspaceId = randomUUID();
      await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, $2, 'EUR', 'Europe/Rome')", [
        workspaceId,
        name,
      ]);
      const accountId = (
        await pool.query<{ id: string }>(
          "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Broker', 'brokerage', 'EUR', false) RETURNING id",
          [workspaceId],
        )
      ).rows[0]!.id;
      const portfolioId = (
        await pool.query<{ id: string }>("INSERT INTO portfolios (workspace_id, name) VALUES ($1, 'Growth') RETURNING id", [workspaceId])
      ).rows[0]!.id;
      const tradeId = (
        await pool.query<{ id: string }>(
          `INSERT INTO trades (workspace_id, account_id, portfolio_id, instrument_id, type, trade_date, quantity_e8, price_e6, gross_cents)
           VALUES ($1, $2, $3, $4, 'buy', '2026-01-10', 1000000000, 100000000, 100000) RETURNING id`,
          [workspaceId, accountId, portfolioId, instrumentId],
        )
      ).rows[0]!.id;
      return { workspaceId, accountId, portfolioId, tradeId };
    }

    before(async () => {
      instrumentId = (
        await pool.query<{ id: string }>(
          "INSERT INTO instruments (ticker, exchange, name, type, currency) VALUES ($1, 'XMIL', 'Schema test fund', 'fund', 'EUR') RETURNING id",
          [`S${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`],
        )
      ).rows[0]!.id;
      workspaceA = await createTradeRows("Trades A");
      workspaceB = await createTradeRows("Trades B");
    });

    after(async () => {
      await pool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[workspaceA.workspaceId, workspaceB.workspaceId]]);
      await pool.query("DELETE FROM instruments WHERE id = $1", [instrumentId]);
    });

    async function asWorkspaceA<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE envelope_app");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceA.workspaceId]);
        return await fn(client);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }

    /** Inserts a trade into workspace A with `columns` over a valid buy's, as envelope_app. */
    async function insertTrade(client: DbClient, columns: Record<string, unknown>): Promise<string> {
      const row: Record<string, unknown> = {
        workspace_id: workspaceA.workspaceId,
        account_id: workspaceA.accountId,
        portfolio_id: workspaceA.portfolioId,
        instrument_id: instrumentId,
        type: "buy",
        trade_date: "2026-02-01",
        quantity_e8: 100000000,
        price_e6: 1000000,
        gross_cents: 100,
        ...columns,
      };
      const names = Object.keys(row);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO trades (${names.join(", ")}) VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING id`,
        Object.values(row),
      );
      return rows[0]!.id;
    }

    async function rejectsWith(fn: () => Promise<unknown>, code: string, constraint: string): Promise<void> {
      await assert.rejects(fn, (error: { code?: string; constraint?: string }) => {
        assert.equal(error.code, code, `expected ${code}, got ${String(error.code)}`);
        assert.equal(error.constraint, constraint);
        return true;
      });
    }

    it("only shows the selected workspace's trades, and inserts only into it", async () => {
      await asWorkspaceA(async (client) => {
        const visible = await client.query("SELECT id FROM trades");
        assert.deepEqual(visible.rows, [{ id: workspaceA.tradeId }]);
        await assert.rejects(() => insertTrade(client, { workspace_id: workspaceB.workspaceId, account_id: workspaceB.accountId, portfolio_id: workspaceB.portfolioId }), /row-level security/);
      });
    });

    it("lets envelope_app update and delete its own workspace's trades only (#509)", async () => {
      await asWorkspaceA(async (client) => {
        const own = await client.query("UPDATE trades SET memo = 'x' WHERE id = $1", [workspaceA.tradeId]);
        assert.equal(own.rowCount, 1);
        const other = await client.query("UPDATE trades SET memo = 'x' WHERE id = $1", [workspaceB.tradeId]);
        assert.equal(other.rowCount, 0);
        const otherDeleted = await client.query("DELETE FROM trades WHERE id = $1", [workspaceB.tradeId]);
        assert.equal(otherDeleted.rowCount, 0);
      });
      await asWorkspaceA(async (client) => {
        const deleted = await client.query("DELETE FROM trades WHERE id = $1", [workspaceA.tradeId]);
        assert.equal(deleted.rowCount, 1);
      });
    });

    it("lets envelope_app update only the columns an edit writes, never a trade's id, workspace, type, link or creation time (#509)", async () => {
      for (const [column, value] of [
        ["id", randomUUID()],
        ["workspace_id", workspaceB.workspaceId],
        ["type", "sell"],
        ["transfer_trade_id", workspaceA.tradeId],
        ["created_at", "2020-01-01T00:00:00Z"],
      ] as const) {
        await asWorkspaceA(async (client) => {
          await assert.rejects(
            () => client.query(`UPDATE trades SET ${column} = $1 WHERE id = $2`, [value, workspaceA.tradeId]),
            /permission denied/,
            column,
          );
        });
      }
      // The control: a column an edit writes.
      await asWorkspaceA(async (client) => {
        const updated = await client.query("UPDATE trades SET fees_cents = 10, memo = 'edited' WHERE id = $1", [workspaceA.tradeId]);
        assert.equal(updated.rowCount, 1);
      });
    });

    it("moves a cash leg with its trade to another account, as envelope_app (#509)", async () => {
      const otherAccountId = (
        await pool.query<{ id: string }>(
          "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Second broker', 'brokerage', 'EUR', false) RETURNING id",
          [workspaceA.workspaceId],
        )
      ).rows[0]!.id;
      await asWorkspaceA(async (client) => {
        const tradeId = await insertTrade(client, { type: "fee", instrument_id: null, quantity_e8: 0, price_e6: 0, gross_cents: 0, fees_cents: 100 });
        const leg = await client.query<{ id: string }>(
          "INSERT INTO transactions (workspace_id, account_id, occurred_at, status, trade_id) VALUES ($1, $2, now(), 'pending', $3) RETURNING id",
          [workspaceA.workspaceId, workspaceA.accountId, tradeId],
        );
        await client.query("UPDATE trades SET account_id = $1 WHERE id = $2", [otherAccountId, tradeId]);
        const moved = await client.query<{ account_id: string }>("SELECT account_id FROM transactions WHERE id = $1", [leg.rows[0]!.id]);
        assert.equal(moved.rows[0]!.account_id, otherAccountId);
        // The leg still cannot leave its trade's account on its own.
        await rejectsWith(
          () => client.query("UPDATE transactions SET account_id = $1 WHERE id = $2", [workspaceA.accountId, leg.rows[0]!.id]),
          "23503",
          "transactions_trade_id_fkey",
        );
      });
    });

    it("does not let a trade or a cash leg reference another workspace's rows", async () => {
      for (const [columns, constraint] of [
        [{ account_id: workspaceB.accountId }, "trades_account_id_fkey"],
        [{ portfolio_id: workspaceB.portfolioId }, "trades_portfolio_id_fkey"],
      ] as const) {
        await asWorkspaceA(async (client) => {
          await rejectsWith(() => insertTrade(client, columns), "23503", constraint);
        });
      }
      await asWorkspaceA(async (client) => {
        // The control: the link to workspace A's own trade is accepted.
        await insertTrade(client, { type: "transfer", quantity_e8: -1, price_e6: 0, gross_cents: 0, transfer_trade_id: workspaceA.tradeId });
      });
      await asWorkspaceA(async (client) => {
        await rejectsWith(
          () => insertTrade(client, { type: "transfer", quantity_e8: -1, price_e6: 0, gross_cents: 0, transfer_trade_id: workspaceB.tradeId }),
          "23503",
          "trades_transfer_trade_id_fkey",
        );
      });
      for (const target of [workspaceA, workspaceB]) {
        const insertLeg = () =>
          asWorkspaceA((client) =>
            client.query(
              "INSERT INTO transactions (workspace_id, account_id, occurred_at, status, trade_id) VALUES ($1, $2, now(), 'cleared', $3)",
              [workspaceA.workspaceId, workspaceA.accountId, target.tradeId],
            ),
          );
        if (target === workspaceA) await insertLeg();
        else await rejectsWith(insertLeg, "23503", "transactions_trade_id_fkey");
      }
    });

    it("enforces each type's columns and the sign rules", async () => {
      const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
        [{ gain_tax_cents: 5 }, "trades_buy_check"],
        [{ quantity_e8: 0 }, "trades_buy_check"],
        [{ instrument_id: null }, "trades_buy_check"],
        [{ withholding_domestic_cents: 5 }, "trades_buy_check"],
        [{ type: "sell", tax_kind: "other" }, "trades_sell_check"],
        [{ type: "dividend", price_e6: 0, quantity_e8: 5 }, "trades_dividend_check"],
        [{ type: "fee", quantity_e8: 0, price_e6: 0, gross_cents: 5 }, "trades_fee_check"],
        [{ type: "tax", quantity_e8: 0, price_e6: 0 }, "trades_tax_check"],
        [{ type: "split", quantity_e8: 0, price_e6: 0, gross_cents: 0, split_from: 1 }, "trades_split_check"],
        [{ type: "transfer", price_e6: 0, gross_cents: 0 }, "trades_transfer_check"],
        [{ type: "transfer", price_e6: 0, gross_cents: 0, cost_basis_cents: 5, transfer_trade_id: workspaceA.tradeId }, "trades_transfer_check"],
        [{ type: "fee", instrument_id: null, quantity_e8: 0, price_e6: 0, gross_cents: 0 }, "trades_fee_check"],
        [{ type: "tax", tax_kind: "stamp_duty", quantity_e8: 0, price_e6: 0, gross_cents: 0 }, "trades_tax_check"],
        [{ type: "tax", tax_kind: "gain_tax_adjustment", quantity_e8: 0, price_e6: 0, gross_cents: 0 }, "trades_tax_check"],
        [{ fees_cents: -1 }, "trades_amounts_not_negative_check"],
        [{ gross_cents: -1 }, "trades_amounts_not_negative_check"],
        [{ type: "tax", tax_kind: "other", quantity_e8: 0, price_e6: 0, gross_cents: -1 }, "trades_amounts_not_negative_check"],
        [{ price_e6: -1 }, "trades_price_e6_range_check"],
        [{ quantity_e8: "9007199254740992" }, "trades_quantity_e8_range_check"],
        [{ memo: "x".repeat(501) }, "trades_memo_check"],
      ];
      for (const [columns, constraint] of cases) {
        await asWorkspaceA(async (client) => {
          await assert.rejects(
            () => insertTrade(client, columns),
            (error: { code?: string; constraint?: string }) => {
              assert.equal(error.code, "23514", JSON.stringify(columns));
              assert.equal(error.constraint, constraint, JSON.stringify(columns));
              return true;
            },
            JSON.stringify(columns),
          );
        });
      }
      await asWorkspaceA(async (client) => {
        await insertTrade(client, { type: "fee", instrument_id: null, quantity_e8: 0, price_e6: 0, gross_cents: 0, fees_cents: 100 });
        await insertTrade(client, { type: "tax", tax_kind: "gain_tax_adjustment", quantity_e8: 0, price_e6: 0, gross_cents: -100 });
        await insertTrade(client, { type: "transfer", quantity_e8: 5, price_e6: 0, gross_cents: 0, cost_basis_cents: 100 });
        await insertTrade(client, { type: "split", quantity_e8: 0, price_e6: 0, gross_cents: 0, split_from: 1, split_to: 4 });
      });
    });

    it("deletes a cash leg with its trade, keeps a portfolio with trades, and lets a workspace with trades go", async () => {
      await asWorkspaceA(async (client) => {
        const tradeId = await insertTrade(client, { type: "fee", instrument_id: null, quantity_e8: 0, price_e6: 0, gross_cents: 0, fees_cents: 100 });
        const insertLeg = () =>
          client.query("INSERT INTO transactions (workspace_id, account_id, occurred_at, status, trade_id) VALUES ($1, $2, now(), 'cleared', $3)", [
            workspaceA.workspaceId,
            workspaceA.accountId,
            tradeId,
          ]);
        await insertLeg();
        // One cash leg per trade.
        await rejectsWith(insertLeg, "23505", "transactions_trade_id_key");
      });

      await asWorkspaceA(async (client) => {
        // A cash leg sits on its trade's own account.
        const otherAccount = await client.query<{ id: string }>(
          "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Other broker', 'brokerage', 'EUR', false) RETURNING id",
          [workspaceA.workspaceId],
        );
        await rejectsWith(
          () =>
            client.query("INSERT INTO transactions (workspace_id, account_id, occurred_at, status, trade_id) VALUES ($1, $2, now(), 'pending', $3)", [
              workspaceA.workspaceId,
              otherAccount.rows[0]!.id,
              workspaceA.tradeId,
            ]),
          "23503",
          "transactions_trade_id_fkey",
        );
      });

      await asWorkspaceA(async (client) => {
        const tradeId = await insertTrade(client, { type: "fee", instrument_id: null, quantity_e8: 0, price_e6: 0, gross_cents: 0, fees_cents: 100 });
        const leg = await client.query<{ id: string }>(
          "INSERT INTO transactions (workspace_id, account_id, occurred_at, status, trade_id) VALUES ($1, $2, now(), 'cleared', $3) RETURNING id",
          [workspaceA.workspaceId, workspaceA.accountId, tradeId],
        );
        // Deleting the trade, as envelope_app (#509), takes its leg with it.
        await client.query("DELETE FROM trades WHERE id = $1", [tradeId]);
        const left = await client.query("SELECT 1 FROM transactions WHERE id = $1", [leg.rows[0]!.id]);
        assert.equal(left.rowCount, 0);
      });

      await asWorkspaceA(async (client) => {
        await rejectsWith(() => client.query("DELETE FROM portfolios WHERE id = $1", [workspaceA.portfolioId]), "23503", "trades_portfolio_id_fkey");
      });

      const doomed = await createTradeRows("Trades doomed");
      await pool.query("DELETE FROM workspaces WHERE id = $1", [doomed.workspaceId]);
      const { rowCount } = await pool.query("SELECT 1 FROM trades WHERE workspace_id = $1", [doomed.workspaceId]);
      assert.equal(rowCount, 0);
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
