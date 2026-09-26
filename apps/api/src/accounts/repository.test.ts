import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { closeAccount, createAccount, listAccounts } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("accounts repository", () => {
  let pool: DbPool;
  let workspaceId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    workspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'Europe/Rome')", [
      workspaceId,
    ]);
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.end();
  });

  it("creates a plain account with no payment category", async () => {
    const account = await createAccount(pool, {
      workspaceId,
      name: "Checking",
      type: "checking",
      currency: "EUR",
      onBudget: true,
    });
    assert.equal(account.name, "Checking");
    assert.equal(account.onBudget, true);
    assert.equal(account.paymentCategoryId, null);
    assert.equal(account.closedAt, null);
  });

  it("creating an on-budget credit card also creates and links its payment category", async () => {
    const account = await createAccount(pool, {
      workspaceId,
      name: "Visa",
      type: "credit_card",
      currency: "EUR",
      onBudget: true,
    });
    assert.ok(account.paymentCategoryId, "expected a payment category to be created and linked");

    const category = await pool.query<{ name: string; group_id: string }>(
      "SELECT name, group_id FROM categories WHERE id = $1",
      [account.paymentCategoryId],
    );
    assert.equal(category.rows[0]?.name, "Visa payment");

    const group = await pool.query<{ name: string }>("SELECT name FROM category_groups WHERE id = $1", [
      category.rows[0]?.group_id,
    ]);
    assert.equal(group.rows[0]?.name, "Credit card payments");
  });

  it("reuses the same payment category group across credit cards", async () => {
    const visa = await createAccount(pool, { workspaceId, name: "Visa 2", type: "credit_card", currency: "EUR", onBudget: true });
    const amex = await createAccount(pool, { workspaceId, name: "Amex", type: "credit_card", currency: "EUR", onBudget: true });

    const groups = await pool.query<{ group_id: string }>("SELECT group_id FROM categories WHERE id = ANY($1)", [
      [visa.paymentCategoryId, amex.paymentCategoryId],
    ]);
    assert.equal(groups.rows[0]?.group_id, groups.rows[1]?.group_id);
  });

  it("an off-budget credit card gets no payment category", async () => {
    const account = await createAccount(pool, {
      workspaceId,
      name: "Off-budget card",
      type: "credit_card",
      currency: "EUR",
      onBudget: false,
    });
    assert.equal(account.paymentCategoryId, null);
  });

  it("a starting balance creates a transaction categorized to the payment category", async () => {
    const account = await createAccount(pool, {
      workspaceId,
      name: "Amex with debt",
      type: "credit_card",
      currency: "EUR",
      onBudget: true,
      startingBalanceCents: -120000,
    });

    const rows = await pool.query<{ payee: string; status: string; category_id: string; amount_cents: string }>(
      `SELECT t.payee, t.status, s.category_id, s.amount_cents
       FROM transactions t JOIN splits s ON s.transaction_id = t.id
       WHERE t.account_id = $1`,
      [account.id],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.payee, "Starting balance");
    assert.equal(rows.rows[0]?.status, "cleared");
    assert.equal(rows.rows[0]?.category_id, account.paymentCategoryId);
    assert.equal(Number(rows.rows[0]?.amount_cents), -120000);
  });

  it("a zero starting balance creates no transaction", async () => {
    const account = await createAccount(pool, {
      workspaceId,
      name: "Fresh card",
      type: "credit_card",
      currency: "EUR",
      onBudget: true,
      startingBalanceCents: 0,
    });
    const { rows } = await pool.query("SELECT 1 FROM transactions WHERE account_id = $1", [account.id]);
    assert.equal(rows.length, 0);
  });

  it("lists every account of a workspace", async () => {
    const otherWorkspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Other', 'EUR', 'Europe/Rome')", [
      otherWorkspaceId,
    ]);
    await createAccount(pool, { workspaceId: otherWorkspaceId, name: "Not mine", type: "cash", currency: "EUR", onBudget: true });

    const accounts = await listAccounts(pool, workspaceId);
    assert.ok(accounts.length > 0);
    assert.ok(accounts.every((a) => a.workspaceId === workspaceId));

    await pool.query("DELETE FROM workspaces WHERE id = $1", [otherWorkspaceId]);
  });

  it("closes an account once; closing it again is a no-op that finds nothing", async () => {
    const account = await createAccount(pool, { workspaceId, name: "To close", type: "cash", currency: "EUR", onBudget: true });

    const closed = await closeAccount(pool, workspaceId, account.id);
    assert.ok(closed?.closedAt);

    const again = await closeAccount(pool, workspaceId, account.id);
    assert.equal(again, undefined);
  });
});
