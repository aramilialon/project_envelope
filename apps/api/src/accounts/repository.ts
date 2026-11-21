import { assertDate, assertKnownCurrency, validateAccountTaxSettings, ValidationError, type LocalDate, type TaxRegime } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";
import { addTaxRegime, isConstraintViolation, notApplicableError } from "./tax-regimes.ts";

export type AccountType = "checking" | "savings" | "cash" | "credit_card" | "brokerage";

export const ACCOUNT_TYPES: readonly AccountType[] = ["checking", "savings", "cash", "credit_card", "brokerage"];

/** Whether a new account of `type` is on budget when the request does not say: a brokerage account never is (#74). */
export function defaultOnBudget(type: AccountType): boolean {
  return type !== "brokerage";
}

export interface AccountRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly onBudget: boolean;
  readonly paymentCategoryId: string | null;
  /** Brokerage accounts only (#508): whether the broker is a domestic withholding agent; null when not recorded. */
  readonly domesticWithholdingAgent: boolean | null;
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
  /** Brokerage accounts only (#508): the regime in force from `taxRegimeValidFrom`. Required in an `IT` workspace. */
  readonly taxRegime?: TaxRegime;
  /**
   * When `taxRegime` was recorded, any date; defaults to today in the workspace's time zone. As
   * the first period, it also applies to every earlier date (`@envelope/core`'s `regimeAt`).
   */
  readonly taxRegimeValidFrom?: LocalDate;
  /** Brokerage accounts only (#508). Required in an `IT` workspace. */
  readonly domesticWithholdingAgent?: boolean;
}

interface AccountRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly on_budget: boolean;
  readonly payment_category_id: string | null;
  readonly domestic_withholding_agent: boolean | null;
  /** `node-postgres` parses `timestamptz` into a `Date`, not a string, despite the column's SQL type. */
  readonly closed_at: Date | null;
  readonly created_at: Date;
}

const ACCOUNT_COLUMNS =
  "id, workspace_id, name, type, currency, on_budget, payment_category_id, domestic_withholding_agent, closed_at, created_at";

/** The shared group every card's payment category lives in, found by this exact name (`findOrCreatePaymentCategoryGroup`). */
export const PAYMENT_CATEGORY_GROUP_NAME = "Credit card payments";

/**
 * Creates an account, and — for an on-budget credit card — its payment
 * category (packages/core's BudgetAccount.paymentCategoryId) and, if given,
 * a starting-balance transaction categorized to it (design.md, "Credit
 * cards"). `db` is expected to already be inside the request's single
 * transaction (workspace-membership.ts), so every write here commits or
 * rolls back together with it.
 *
 * @throws ValidationError with code "brokerage_on_budget" for an on-budget
 * brokerage account. Migration 0025's CHECK constraint is the only rule:
 * its violation is mapped to that code here. The failed INSERT leaves the
 * request's transaction aborted, so it rolls back and nothing is stored.
 *
 * A brokerage account's tax settings (#508) are checked against the
 * workspace's tax country by `@envelope/core`'s `validateAccountTaxSettings`
 * before anything is written; its first regime, when given, is stored in
 * `account_tax_regimes` (`tax-regimes.ts`) in the same transaction.
 *
 * @throws ValidationError "tax_regime_required" / "tax_regime_not_applicable"
 * from `validateAccountTaxSettings`, and "invalid_date" for a bad
 * `taxRegimeValidFrom`.
 *
 * @throws ValidationError "account_currency_not_base" (`details`: `currency`,
 * `baseCurrency`) for an on-budget account, card included, whose currency is
 * not the workspace's base currency (#652): the budget is in one currency,
 * and amounts in different currencies are never added together. An
 * off-budget account keeps any currency.
 * @throws ValidationError "invalid_currency" (`details`: `currency`) for a
 * currency that is not an upper-case ISO 4217 code the runtime knows
 * (`@envelope/core`'s `assertKnownCurrency`, #652).
 */
export async function createAccount(db: DbPool | DbClient, input: CreateAccountInput): Promise<AccountRecord> {
  assertKnownCurrency(input.currency);
  const workspace = await workspaceSettings(db, input.workspaceId);
  if (input.onBudget && workspace !== undefined && input.currency !== workspace.baseCurrency) {
    throw new ValidationError("account_currency_not_base", "an on-budget account must be in the workspace's base currency", {
      currency: input.currency,
      baseCurrency: workspace.baseCurrency,
    });
  }
  validateAccountTaxSettings({
    accountType: input.type,
    taxCountry: workspace?.taxCountry ?? null,
    taxRegime: input.taxRegime,
    domesticWithholdingAgent: input.domesticWithholdingAgent,
  });
  // Checked before the INSERT, not by `addTaxRegime` after it: a request that fails after the
  // account row is written could still commit that row without its regime.
  if (input.taxRegimeValidFrom !== undefined) {
    assertDate(input.taxRegimeValidFrom);
  }

  let rows: AccountRow[];
  try {
    ({ rows } = await db.query<AccountRow>(
      `INSERT INTO accounts (workspace_id, name, type, currency, on_budget, domestic_withholding_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${ACCOUNT_COLUMNS}`,
      [input.workspaceId, input.name, input.type, input.currency, input.onBudget, input.domesticWithholdingAgent ?? null],
    ));
  } catch (error) {
    if (isBrokerageOffBudgetViolation(error)) {
      throw brokerageOnBudgetError();
    }
    if (isConstraintViolation(error, CHECK_VIOLATION, "accounts_withholding_agent_brokerage_check")) {
      throw notApplicableError(input.type, "domesticWithholdingAgent");
    }
    throw error;
  }
  const account = rows[0];
  if (!account) {
    throw new Error("createAccount: INSERT ... RETURNING produced no row");
  }

  if (input.taxRegime !== undefined) {
    await addTaxRegime(db, input.workspaceId, account.id, {
      regime: input.taxRegime,
      ...(input.taxRegimeValidFrom === undefined ? {} : { validFrom: input.taxRegimeValidFrom }),
    });
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

/**
 * Whether `accountId` names an account of this workspace, open or closed (#512). Asked before a
 * write that names an account from the request, so an account of another workspace is answered
 * as not found instead of reaching the foreign key or Row-Level Security as a database error.
 */
export async function accountExists(db: DbPool | DbClient, workspaceId: string, accountId: string): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM accounts WHERE id = $1 AND workspace_id = $2", [accountId, workspaceId]);
  return rows.length > 0;
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

/** The workspace's base currency and tax country (#508, null when it has none), or undefined when it is not found. */
async function workspaceSettings(
  db: DbPool | DbClient,
  workspaceId: string,
): Promise<{ readonly baseCurrency: string; readonly taxCountry: string | null } | undefined> {
  const { rows } = await db.query<{ base_currency: string; tax_country: string | null }>(
    "SELECT base_currency, tax_country FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  const row = rows[0];
  return row === undefined ? undefined : { baseCurrency: row.base_currency, taxCountry: row.tax_country };
}

const CHECK_VIOLATION = "23514";
const BROKERAGE_OFF_BUDGET_CONSTRAINT = "accounts_brokerage_off_budget_check";

function brokerageOnBudgetError(): ValidationError {
  return new ValidationError("brokerage_on_budget", "a brokerage account is always off budget", { type: "brokerage" });
}

/** Whether `error` is PostgreSQL rejecting a row through migration 0025's `accounts_brokerage_off_budget_check`. */
export function isBrokerageOffBudgetViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === CHECK_VIOLATION && constraint === BROKERAGE_OFF_BUDGET_CONSTRAINT;
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
    domesticWithholdingAgent: row.domestic_withholding_agent,
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}
