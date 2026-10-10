import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { isValidationError } from "@envelope/core";

import { createAssignmentBatch } from "../assignments/repository.ts";
import { createTransaction, createTransfer } from "../transactions/repository.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { createScheduledTransaction } from "../scheduled-transactions/repository.ts";
import { getBudgetMonth, listBudgetProblems } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("budget month repository", () => {
  let pool: DbPool;
  let workspaceId: string;
  let authorId: string;
  let checkingAccountId: string;
  let offBudgetAccountId: string;
  let groupId: string;
  let categoryId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    workspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [
      workspaceId,
    ]);
    const user = await pool.query<{ id: string }>(
      "INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id",
      [randomUUID(), `${randomUUID()}@example.com`],
    );
    authorId = user.rows[0]!.id;
    const account = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    checkingAccountId = account.rows[0]!.id;
    const offBudgetAccount = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Brokerage', 'savings', 'EUR', false) RETURNING id",
      [workspaceId],
    );
    offBudgetAccountId = offBudgetAccount.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    groupId = group.rows[0]!.id;
    const category = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, groupId],
    );
    categoryId = category.rows[0]!.id;
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.query("DELETE FROM users WHERE id = $1", [authorId]);
    await pool.end();
  });

  it("computes unassigned money and a category's available amount, joined with its name/group/sort order", async () => {
    await createTransaction(pool, {
      workspaceId,
      accountId: checkingAccountId,
      occurredAt: "2026-09-01",
      splits: [{ categoryId: null, amountCents: 100_000 }],
    });
    await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 40_000 }],
    });
    await createTransaction(pool, {
      workspaceId,
      accountId: checkingAccountId,
      occurredAt: "2026-09-10",
      splits: [{ categoryId, amountCents: -10_000 }],
    });

    const september = await getBudgetMonth(pool, workspaceId, "2026-09");
    assert.equal(september.unassigned, 60_000);

    const groceries = september.categories.find((c) => c.categoryId === categoryId);
    assert.equal(groceries?.name, "Groceries");
    assert.equal(groceries?.groupId, groupId);
    assert.equal(groceries?.groupName, "Home");
    assert.equal(groceries?.sortOrder, 1);
    assert.equal(groceries?.carriedOver, 0);
    assert.equal(groceries?.assigned, 40_000);
    assert.equal(groceries?.activity, -10_000);
    assert.equal(groceries?.available, 30_000);
  });

  it("rolls a category's positive available balance over to the next month", async () => {
    const october = await getBudgetMonth(pool, workspaceId, "2026-10");
    const groceries = october.categories.find((c) => c.categoryId === categoryId);
    assert.equal(groceries?.carriedOver, 30_000);
    assert.equal(groceries?.assigned, 0);
    assert.equal(groceries?.activity, 0);
    assert.equal(groceries?.available, 30_000);
    assert.equal(october.unassigned, 60_000); // unaffected: no new income or assignments in October
  });

  it("shows a credit card's starting-balance debt as uncovered, and unassigned money as unaffected", async () => {
    const cardAccount = await pool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Card', 'credit_card', 'EUR', true) RETURNING id",
      [workspaceId],
    );
    const cardAccountId = cardAccount.rows[0]!.id;
    const paymentCategory = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Card payment', 2) RETURNING id",
      [workspaceId, groupId],
    );
    const paymentCategoryId = paymentCategory.rows[0]!.id;
    await pool.query("UPDATE accounts SET payment_category_id = $1 WHERE id = $2", [paymentCategoryId, cardAccountId]);
    // A starting balance dated before the test month, exactly as accounts/repository.ts's
    // createStartingBalanceTransaction records one, but with a controlled date instead of now().
    await createTransaction(pool, {
      workspaceId,
      accountId: cardAccountId,
      occurredAt: "2026-08-01",
      status: "cleared",
      splits: [{ categoryId: paymentCategoryId, amountCents: -120_000 }],
    });

    const withNothingAssigned = await getBudgetMonth(pool, workspaceId, "2026-11");
    const cardBefore = withNothingAssigned.paymentCategories.find((c) => c.categoryId === paymentCategoryId);
    assert.equal(cardBefore?.available, 0);
    assert.equal(cardBefore?.uncovered, 120_000);
    const unassignedBefore = withNothingAssigned.unassigned;

    await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month: "2026-11", sourceCategoryId: null, destinationCategoryId: paymentCategoryId, amountCents: 20_000 }],
    });

    const withSomeAssigned = await getBudgetMonth(pool, workspaceId, "2026-11");
    const cardAfter = withSomeAssigned.paymentCategories.find((c) => c.categoryId === paymentCategoryId);
    assert.equal(cardAfter?.available, 20_000);
    assert.equal(cardAfter?.uncovered, 100_000);
    assert.equal(withSomeAssigned.unassigned, unassignedBefore - 20_000);
  });

  it("a packages/core ValidationError surfaces with its stable code, not a raw message", async () => {
    await assert.rejects(
      () => getBudgetMonth(pool, workspaceId, "not-a-month"),
      (error: unknown) => isValidationError(error, "invalid_month"),
    );
  });

  it("lists unassigned money as a problem when positive", async () => {
    const budgetMonth = await getBudgetMonth(pool, workspaceId, "2026-09");
    assert.ok(budgetMonth.unassigned > 0, "expected the fixture to still have unassigned money in September");

    const problems = await listBudgetProblems(pool, workspaceId, "2026-09");
    const unassignedProblem = problems.find((p) => p.kind === "unassigned_money");
    assert.equal(unassignedProblem?.amountCents, budgetMonth.unassigned);
  });

  it("lists an overspent category, with enough detail to link to it", async () => {
    const overspentCategory = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Overspent', 3) RETURNING id",
      [workspaceId, groupId],
    );
    const overspentCategoryId = overspentCategory.rows[0]!.id;
    await createTransaction(pool, {
      workspaceId,
      accountId: checkingAccountId,
      occurredAt: "2026-12-01",
      splits: [{ categoryId: overspentCategoryId, amountCents: -5_000 }],
    });

    const problems = await listBudgetProblems(pool, workspaceId, "2026-12");
    const problem = problems.find((p) => p.categoryId === overspentCategoryId);
    assert.equal(problem?.kind, "overspent_category");
    assert.equal(problem?.name, "Overspent");
    assert.equal(problem?.groupName, "Home");
    assert.equal(problem?.amountCents, 5_000);
  });

  it("lists uncovered card debt as its own kind of problem, even when the category is not itself negative", async () => {
    const budgetMonth = await getBudgetMonth(pool, workspaceId, "2026-11");
    const cardCategory = budgetMonth.paymentCategories.find((c) => c.uncovered > 0);
    assert.ok(cardCategory, "expected the card fixture to still have uncovered debt in November");
    assert.ok(cardCategory!.available >= 0, "this problem kind is meant for debt that is not itself a negative available");

    const problems = await listBudgetProblems(pool, workspaceId, "2026-11");
    const problem = problems.find((p) => p.categoryId === cardCategory!.categoryId && p.kind === "uncovered_card_debt");
    assert.equal(problem?.amountCents, cardCategory!.uncovered);
  });

  it("surfaces a scheduled transaction's reservation as reserved money, net from available, only in its own due month", async () => {
    await createScheduledTransaction(pool, {
      workspaceId,
      accountId: checkingAccountId,
      nextDueDate: "2027-01-05",
      recurEvery: 1,
      recurUnit: "month",
      splits: [{ categoryId, amountCents: 15_000 }],
    });

    const january = await getBudgetMonth(pool, workspaceId, "2027-01");
    const groceries = january.categories.find((c) => c.categoryId === categoryId);
    assert.equal(groceries?.reserved, 15_000);
    assert.equal(january.reserved, 15_000);

    // design.md, "Scheduled transactions": reservations do not carry over to another month.
    const december = await getBudgetMonth(pool, workspaceId, "2026-12");
    const groceriesDecember = december.categories.find((c) => c.categoryId === categoryId);
    assert.equal(groceriesDecember?.reserved, 0);
    assert.equal(december.reserved, 0);
  });

  it("counts a transfer to an off-budget account as activity on its on-budget leg's category, not an uncategorized transaction (#378)", async () => {
    const otherCategory = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Investments', 4) RETURNING id",
      [workspaceId, groupId],
    );
    const investmentsCategoryId = otherCategory.rows[0]!.id;
    await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month: "2026-10", sourceCategoryId: null, destinationCategoryId: investmentsCategoryId, amountCents: 20_000 }],
    });
    await createTransfer(pool, {
      workspaceId,
      sourceAccountId: checkingAccountId,
      destinationAccountId: offBudgetAccountId,
      occurredAt: "2026-10-05",
      amountCents: 12_000,
      categoryId: investmentsCategoryId,
    });

    const october = await getBudgetMonth(pool, workspaceId, "2026-10");
    const investments = october.categories.find((c) => c.categoryId === investmentsCategoryId);
    assert.equal(investments?.activity, -12_000);
    assert.equal(investments?.available, 8_000);
  });
});
