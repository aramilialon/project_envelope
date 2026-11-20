/**
 * A brokerage account's tax regime history (#508; migration 0028): one row per period, each in
 * force from its own `validFrom` until the next row's. `@envelope/core`'s
 * `validateTaxRegimeHistory` checks the rules before a row is written; migration 0028's primary
 * key and trigger enforce the same rules in the database, and a violation of either is mapped to
 * the same `ValidationError` code here.
 */
import { validateTaxRegimeHistory, ValidationError, type LocalDate, type TaxRegime, type TaxRegimeEntry } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";

export interface AddTaxRegimeInput {
  readonly regime: TaxRegime;
  /** Defaults to today in the workspace's time zone. */
  readonly validFrom?: LocalDate;
}

interface TaxRegimeRow {
  readonly valid_from: string;
  readonly regime: TaxRegime;
}

/** The account's regime history, oldest first; undefined if the account is not in this workspace. */
export async function listTaxRegimes(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
): Promise<TaxRegimeEntry[] | undefined> {
  const account = await db.query("SELECT 1 FROM accounts WHERE id = $1 AND workspace_id = $2", [accountId, workspaceId]);
  if (account.rows.length === 0) {
    return undefined;
  }
  return loadHistory(db, workspaceId, accountId);
}

/**
 * Adds a regime to the account's history: its first regime on any date, or a change on 1 January.
 * Returns undefined if the account is not in this workspace.
 *
 * @throws ValidationError "tax_regime_not_applicable" if the account is not a brokerage account;
 * "tax_regime_change_not_year_start", "tax_regime_duplicate_date" or "invalid_date" from
 * `validateTaxRegimeHistory`.
 */
export async function addTaxRegime(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  input: AddTaxRegimeInput,
): Promise<TaxRegimeEntry | undefined> {
  // Locks the account row, as migration 0028's trigger does, so two changes to the same
  // account are checked one after the other.
  const { rows } = await db.query<{ type: string; today: string }>(
    `SELECT a.type, to_char(now() AT TIME ZONE w.time_zone, 'YYYY-MM-DD') AS today
     FROM accounts a JOIN workspaces w ON w.id = a.workspace_id
     WHERE a.id = $1 AND a.workspace_id = $2
     FOR UPDATE OF a`,
    [accountId, workspaceId],
  );
  const account = rows[0];
  if (!account) {
    return undefined;
  }
  if (account.type !== "brokerage") {
    throw notApplicableError(account.type);
  }

  const entry: TaxRegimeEntry = { validFrom: input.validFrom ?? account.today, regime: input.regime };
  validateTaxRegimeHistory([...(await loadHistory(db, workspaceId, accountId)), entry]);

  try {
    await db.query("INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, $3, $4)", [
      workspaceId,
      accountId,
      entry.validFrom,
      entry.regime,
    ]);
  } catch (error) {
    throw toValidationError(error, entry, account.type) ?? error;
  }
  return entry;
}

async function loadHistory(db: DbPool | DbClient, workspaceId: string, accountId: string): Promise<TaxRegimeEntry[]> {
  const { rows } = await db.query<TaxRegimeRow>(
    `SELECT to_char(valid_from, 'YYYY-MM-DD') AS valid_from, regime
     FROM account_tax_regimes
     WHERE account_id = $1 AND workspace_id = $2
     ORDER BY valid_from`,
    [accountId, workspaceId],
  );
  return rows.map((row) => ({ validFrom: row.valid_from, regime: row.regime }));
}

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

/** Whether `error` is PostgreSQL rejecting a row through the constraint named `constraint` with SQLSTATE `code`. */
export function isConstraintViolation(error: unknown, code: string, constraint: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const violation = error as { code?: unknown; constraint?: unknown };
  return violation.code === code && violation.constraint === constraint;
}

export function notApplicableError(type: string, field = "taxRegime"): ValidationError {
  return new ValidationError("tax_regime_not_applicable", `only a brokerage account takes ${field}`, { field, type });
}

/** Maps migration 0028's own rules to the codes `validateTaxRegimeHistory` uses, or undefined for any other error. */
function toValidationError(error: unknown, entry: TaxRegimeEntry, type: string): ValidationError | undefined {
  if (isConstraintViolation(error, UNIQUE_VIOLATION, "account_tax_regimes_pkey")) {
    return new ValidationError("tax_regime_duplicate_date", `two tax regimes start on ${entry.validFrom}`, {
      validFrom: entry.validFrom,
    });
  }
  if (isConstraintViolation(error, CHECK_VIOLATION, "account_tax_regimes_year_start_check")) {
    return new ValidationError("tax_regime_change_not_year_start", "a tax regime change must start on 1 January", {
      validFrom: entry.validFrom,
    });
  }
  if (isConstraintViolation(error, CHECK_VIOLATION, "account_tax_regimes_brokerage_check")) {
    return notApplicableError(type);
  }
  return undefined;
}
