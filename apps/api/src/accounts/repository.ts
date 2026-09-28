import type { DbClient, DbPool } from "../db/pool.ts";

export type AccountType = "checking" | "savings" | "cash" | "credit_card";

export interface AccountRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly onBudget: boolean;
  readonly paymentCategoryId: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
}

export interface CreateAccountInput {
  readonly workspaceId: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly onBudget: boolean;
  /** Only meaningful for an on-budget credit_card account; negative = debt already owed. */
  readonly startingBalanceCents?: number;
}

interface AccountRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly on_budget: boolean;
  readonly payment_category_id: string | null;
  /** `node-postgres` parses `timestamptz` into a `Date`, not a string, despite the column's SQL type. */
  readonly closed_at: Date | null;
  readonly created_at: Date;
}

const ACCOUNT_COLUMNS = "id, workspace_id, name, type, currency, on_budget, payment_category_id, closed_at, created_at";

const PAYMENT_CATEGORY_GROUP_NAME = "Credit card payments";

/**
 * Creates an account, and — for an on-budget credit card — its payment
 * category (packages/core's BudgetAccount.paymentCategoryId) and, if given,
 * a starting-balance transaction categorized to it (design.md, "Credit
 * cards"). `db` is expected to already be inside the request's single
 * transaction (workspace-membership.ts), so every write here commits or
 * rolls back together with it.
 */
export async function createAccount(db: DbPool | DbClient, input: CreateAccountInput): Promise<AccountRecord> {
  const { rows } = await db.query<AccountRow>(
    `INSERT INTO accounts (workspace_id, name, type, currency, on_budget)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${ACCOUNT_COLUMNS}`,
    [input.workspaceId, input.name, input.type, input.currency, input.onBudget],
  );
  const account = rows[0];
  if (!account) {
    throw new Error("createAccount: INSERT ... RETURNING produced no row");
  }

  if (input.type !== "credit_card" || !input.onBudget) {
    return toAccountRecord(account);
  }

  const paymentCategoryId = await createPaymentCategory(db, input.workspaceId, input.name);
  await db.query("UPDATE accounts SET payment_category_id = $1 WHERE id = $2", [paymentCategoryId, account.id]);

  if (input.startingBalanceCents !== undefined && input.startingBalanceCents !== 0) {
    await createStartingBalanceTransaction(
      db,
      input.workspaceId,
      account.id,
      paymentCategoryId,
      input.startingBalanceCents,
    );
  }

  return toAccountRecord({ ...account, payment_category_id: paymentCategoryId });
}

export async function listAccounts(db: DbPool | DbClient, workspaceId: string): Promise<AccountRecord[]> {
  const { rows } = await db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE workspace_id = $1 ORDER BY created_at`,
    [workspaceId],
  );
  return rows.map(toAccountRecord);
}

/** Closes an account (excluded from budget calculations, never deleted). Returns undefined if not found or already closed. */
export async function closeAccount(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
): Promise<AccountRecord | undefined> {
  const { rows } = await db.query<AccountRow>(
    `UPDATE accounts SET closed_at = now()
     WHERE id = $1 AND workspace_id = $2 AND closed_at IS NULL
     RETURNING ${ACCOUNT_COLUMNS}`,
    [accountId, workspaceId],
  );
  return rows[0] ? toAccountRecord(rows[0]) : undefined;
}

async function createPaymentCategory(db: DbPool | DbClient, workspaceId: string, accountName: string): Promise<string> {
  const groupId = await findOrCreatePaymentCategoryGroup(db, workspaceId);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO categories (workspace_id, group_id, name, sort_order)
     VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories WHERE group_id = $2))
     RETURNING id`,
    [workspaceId, groupId, `${accountName} payment`],
  );
  const category = rows[0];
  if (!category) {
    throw new Error("createPaymentCategory: INSERT ... RETURNING produced no row");
  }
  return category.id;
}

/**
 * Finds this workspace's shared "Credit card payments" group, creating it on
 * first use. Find-then-create, not atomic: two accounts created at the exact
 * same instant could each create their own group. Accepted for now given the
 * low concurrency of a personal/family workspace; #12 owns any future
 * uniqueness constraint on category_groups.
 */
async function findOrCreatePaymentCategoryGroup(db: DbPool | DbClient, workspaceId: string): Promise<string> {
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM category_groups WHERE workspace_id = $1 AND name = $2",
    [workspaceId, PAYMENT_CATEGORY_GROUP_NAME],
  );
  const found = existing.rows[0];
  if (found) {
    return found.id;
  }

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO category_groups (workspace_id, name, sort_order)
     VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM category_groups WHERE workspace_id = $1))
     RETURNING id`,
    [workspaceId, PAYMENT_CATEGORY_GROUP_NAME],
  );
  const group = rows[0];
  if (!group) {
    throw new Error("findOrCreatePaymentCategoryGroup: INSERT ... RETURNING produced no row");
  }
  return group.id;
}

async function createStartingBalanceTransaction(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  paymentCategoryId: string,
  amountCents: number,
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO transactions (workspace_id, account_id, occurred_at, payee, status)
     VALUES ($1, $2, now(), 'Starting balance', 'cleared')
     RETURNING id`,
    [workspaceId, accountId],
  );
  const transaction = rows[0];
  if (!transaction) {
    throw new Error("createStartingBalanceTransaction: INSERT ... RETURNING produced no row");
  }
  await db.query("INSERT INTO splits (workspace_id, transaction_id, category_id, amount_cents) VALUES ($1, $2, $3, $4)", [
    workspaceId,
    transaction.id,
    paymentCategoryId,
    amountCents,
  ]);
}

function toAccountRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    onBudget: row.on_budget,
    paymentCategoryId: row.payment_category_id,
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}
