/**
 * A brokerage account's tax regime history (#508; migration 0028): one row per period, each in
 * force from its own `validFrom` until the next row's, the earliest also before it.
 * `@envelope/core`'s `validateTaxRegimeChange` checks the rules before anything is written;
 * migration 0028's primary key and trigger enforce the history rules in the database too, and a
 * violation of either is mapped to the same `ValidationError` code here.
 */
import {
  validateTaxRegimeChange,
  validateWithholdingAgentChange,
  ValidationError,
  type LocalDate,
  type TaxRegime,
  type TaxRegimeEntry,
} from "@envelope/core";

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

interface LockedAccount {
  readonly type: string;
  readonly domestic_withholding_agent: boolean | null;
  readonly tax_country: string | null;
  readonly today: string;
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
 * @throws ValidationError "tax_regime_not_applicable" if the account is not a brokerage account
 * or the workspace's tax country is not `IT`; the codes of `validateTaxRegimeChange`.
 */
export async function addTaxRegime(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  input: AddTaxRegimeInput,
): Promise<TaxRegimeEntry | undefined> {
  const account = await lockAccount(db, workspaceId, accountId);
  if (!account) {
    return undefined;
  }
  assertBrokerage(account.type);

  const entry: TaxRegimeEntry = { validFrom: input.validFrom ?? account.today, regime: input.regime };
  validateTaxRegimeChange({
    taxCountry: account.tax_country,
    domesticWithholdingAgent: account.domestic_withholding_agent,
    history: [...(await loadHistory(db, workspaceId, accountId)), entry],
  });
  await insertEntries(db, workspaceId, accountId, [entry], account.type);
  return entry;
}

/**
 * Replaces the account's whole history with `history` (a correction, #508): the old rows are
 * deleted and the new ones inserted, oldest first, in the request's transaction and under the
 * account's lock, so nothing sees a half-replaced history. Returns the stored history, oldest
 * first, or undefined if the account is not in this workspace.
 *
 * @throws ValidationError, the same codes as `addTaxRegime`.
 */
export async function replaceTaxRegimes(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  history: readonly TaxRegimeEntry[],
): Promise<TaxRegimeEntry[] | undefined> {
  const account = await lockAccount(db, workspaceId, accountId);
  if (!account) {
    return undefined;
  }
  assertBrokerage(account.type);
  validateTaxRegimeChange({
    taxCountry: account.tax_country,
    domesticWithholdingAgent: account.domestic_withholding_agent,
    history,
  });

  const sorted = [...history].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
  await db.query("DELETE FROM account_tax_regimes WHERE account_id = $1 AND workspace_id = $2", [accountId, workspaceId]);
  await insertEntries(db, workspaceId, accountId, sorted, account.type);
  return sorted;
}

/**
 * Sets a brokerage account's withholding-agent flag once, while it has none (#508: an account
 * created before its workspace's tax country became `IT`). Returns false if the account is not in
 * this workspace.
 *
 * @throws ValidationError from `@envelope/core`'s `validateWithholdingAgentChange`.
 */
export async function setWithholdingAgent(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  domesticWithholdingAgent: boolean,
): Promise<boolean> {
  const account = await lockAccount(db, workspaceId, accountId);
  if (!account) {
    return false;
  }
  validateWithholdingAgentChange({
    accountType: account.type,
    taxCountry: account.tax_country,
    current: account.domestic_withholding_agent,
  });
  await db.query("UPDATE accounts SET domestic_withholding_agent = $3 WHERE id = $1 AND workspace_id = $2", [
    accountId,
    workspaceId,
    domesticWithholdingAgent,
  ]);
  return true;
}

/**
 * Locks the account row, as migration 0028's trigger does (FOR NO KEY UPDATE), so two changes to
 * the same account are checked one after the other; undefined if it is not in this workspace.
 */
async function lockAccount(db: DbPool | DbClient, workspaceId: string, accountId: string): Promise<LockedAccount | undefined> {
  const { rows } = await db.query<LockedAccount>(
    `SELECT a.type, a.domestic_withholding_agent, w.tax_country,
            to_char(now() AT TIME ZONE w.time_zone, 'YYYY-MM-DD') AS today
     FROM accounts a JOIN workspaces w ON w.id = a.workspace_id
     WHERE a.id = $1 AND a.workspace_id = $2
     FOR NO KEY UPDATE OF a`,
    [accountId, workspaceId],
  );
  return rows[0];
}

function assertBrokerage(type: string): void {
  if (type !== "brokerage") {
    throw notApplicableError(type);
  }
}

async function insertEntries(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  entries: readonly TaxRegimeEntry[],
  type: string,
): Promise<void> {
  // One row at a time, oldest first: the trigger checks each against the rows already there.
  for (const entry of entries) {
    try {
      await db.query("INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, $3, $4)", [
        workspaceId,
        accountId,
        entry.validFrom,
        entry.regime,
      ]);
    } catch (error) {
      throw toValidationError(error, entry, type) ?? error;
    }
  }
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

/** Maps migration 0028's own rules to the codes `@envelope/core` uses, or undefined for any other error. */
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
  if (isConstraintViolation(error, CHECK_VIOLATION, "account_tax_regimes_withholding_agent_check")) {
    return new ValidationError(
      "tax_regime_requires_withholding_agent",
      `the ${entry.regime} regime needs a broker that is a domestic withholding agent`,
      { regime: entry.regime },
    );
  }
  if (isConstraintViolation(error, CHECK_VIOLATION, "account_tax_regimes_brokerage_check")) {
    return notApplicableError(type);
  }
  return undefined;
}
