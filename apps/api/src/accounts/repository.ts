import {
  assertAmount,
  assertDate,
  assertKnownCurrency,
  assertTotal,
  computePositions,
  validateAccountTaxSettings,
  ValidationError,
  type LocalDate,
  type TaxRegime,
} from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";
import { loadPositionTrades } from "../trades/repository.ts";
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
 * from `validateAccountTaxSettings`, "invalid_date" for a bad
 * `taxRegimeValidFrom`, and "invalid_amount"/"amount_too_large" for a
 * starting balance that is not a whole number of minor units or is beyond the
 * cap (ADR 0002).
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
  if (input.startingBalanceCents !== undefined) {
    assertAmount(input.startingBalanceCents, "startingBalance");
  }
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

/** Why `closeAccount` refused an account (#703, #729): every figure is one the user can see on screen. */
export interface AccountNotEmptyDetails {
  /** The account's balance as of today in the workspace's time zone, in its own currency: the register's head figure (#702). */
  readonly balanceCents: number;
  /**
   * The rows dated after today: its transactions, and its trades that move no cash (a transfer of
   * securities, a split), with the earliest one's date ("YYYY-MM-DD", null when there are none).
   */
  readonly laterRows: { readonly count: number; readonly firstDate: LocalDate | null };
  /** Whether it holds any security today (a position with a quantity other than zero). */
  readonly holdsPositions: boolean;
  /** The scheduled transactions on it, which would keep writing to it. */
  readonly scheduled: { readonly count: number };
}

/**
 * Whether `accountId` names a closed account of this workspace (#729). For a refusal a route gives
 * before any write, such as staging an import into it; the writes themselves are refused by the
 * database (migration 0033, ADR 0018) whatever a route checks.
 */
export async function isAccountClosed(db: DbPool | DbClient, workspaceId: string, accountId: string): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM accounts WHERE id = $1 AND workspace_id = $2 AND closed_at IS NOT NULL", [
    accountId,
    workspaceId,
  ]);
  return rows.length > 0;
}

/** What `closeAccount` did: closed it, found no open account by that id, or refused it as not empty (#703, #729). */
export type CloseAccountResult =
  | { readonly status: "closed"; readonly account: AccountRecord }
  | { readonly status: "not_found" }
  | ({ readonly status: "not_empty" } & AccountNotEmptyDetails);

/**
 * Closes an account, never deleting it. A closed account still counts in the budget: its
 * transactions stay in every month they fall in. Returns `not_found` if it is not found or is
 * already closed.
 *
 * Closes it only when it is empty today and later (#729), "today" in the workspace's time zone:
 * its balance today is zero and no transaction is dated after today; it holds no security today and
 * no trade is dated after today; and no scheduled transaction uses it. Anything else is refused,
 * and the route answers 409 `account_not_empty` with the details. Checked as of today, as every
 * screen shows the account (#702), rather than over all dates: a row dated later would otherwise
 * leave the account with money on a later day, or cancel today's balance on screen.
 *
 * The account row is locked first (`FOR UPDATE`, which conflicts with the `FOR KEY SHARE` lock
 * migration 0033's trigger takes for every write to the account, and the key-share lock of its
 * foreign keys), so nothing can be written to it between the check and the close, and once closed
 * nothing can be written to it at all (ADR 0018).
 *
 * @throws ValidationError "amount_total_overflow" when the balance is beyond the safe range.
 */
export async function closeAccount(db: DbClient, workspaceId: string, accountId: string): Promise<CloseAccountResult> {
  const { rows: lockedRows } = await db.query<{ today: string }>(
    `SELECT to_char(now() AT TIME ZONE w.time_zone, 'YYYY-MM-DD') AS today
     FROM accounts a JOIN workspaces w ON w.id = a.workspace_id
     WHERE a.id = $1 AND a.workspace_id = $2 AND a.closed_at IS NULL
     FOR UPDATE OF a`,
    [accountId, workspaceId],
  );
  const today = lockedRows[0]?.today;
  if (today === undefined) {
    return { status: "not_found" };
  }

  const { rows: balanceRows } = await db.query<{ balance_cents: string }>(
    `SELECT COALESCE(SUM(s.amount_cents), 0)::text AS balance_cents
     FROM splits s
     JOIN transactions t ON t.workspace_id = s.workspace_id AND t.id = s.transaction_id
     JOIN workspaces w ON w.id = t.workspace_id
     WHERE t.workspace_id = $1 AND t.account_id = $2
       AND to_char(t.occurred_at AT TIME ZONE w.time_zone, 'YYYY-MM-DD') <= $3`,
    [workspaceId, accountId, today],
  );
  const balanceCents = Number(balanceRows[0]?.balance_cents ?? "0");
  assertTotal(balanceCents, "balanceCents", { accountId });

  // A trade's cash leg is one of the transactions already counted, dated on the trade date; only a
  // trade that moves no cash is a row of its own here.
  const { rows: laterRows } = await db.query<{ count: number; first_date: string | null }>(
    `SELECT count(*)::int AS count, min(date) AS first_date FROM (
       SELECT to_char(t.occurred_at AT TIME ZONE w.time_zone, 'YYYY-MM-DD') AS date
       FROM transactions t JOIN workspaces w ON w.id = t.workspace_id
       WHERE t.workspace_id = $1 AND t.account_id = $2
       UNION ALL
       SELECT to_char(tr.trade_date, 'YYYY-MM-DD') AS date
       FROM trades tr
       WHERE tr.workspace_id = $1 AND tr.account_id = $2
         AND NOT EXISTS (SELECT 1 FROM transactions c WHERE c.workspace_id = tr.workspace_id AND c.trade_id = tr.id)
     ) AS rows WHERE date > $3`,
    [workspaceId, accountId, today],
  );
  const later = { count: laterRows[0]?.count ?? 0, firstDate: laterRows[0]?.first_date ?? null };

  // Only a brokerage account has trades: for any other account the replay finds none. The replay
  // stops at today, so a sale dated later does not empty a holding held today.
  const trades = (await loadPositionTrades(db, workspaceId, { accountId })).filter((trade) => trade.date <= today);
  const { accounts: positions } = computePositions(trades);
  const holdsPositions = positions.some((position) => position.accountId === accountId && position.quantity !== 0);

  const { rows: scheduledRows } = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM scheduled_transactions WHERE workspace_id = $1 AND account_id = $2",
    [workspaceId, accountId],
  );
  const scheduled = { count: scheduledRows[0]?.count ?? 0 };

  if (balanceCents !== 0 || later.count > 0 || holdsPositions || scheduled.count > 0) {
    return { status: "not_empty", balanceCents, laterRows: later, holdsPositions, scheduled };
  }

  const { rows } = await db.query<AccountRow>(
    `UPDATE accounts SET closed_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING ${ACCOUNT_COLUMNS}`,
    [accountId, workspaceId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("closeAccount: the locked account row was not updated");
  }
  return { status: "closed", account: toAccountRecord(row) };
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
