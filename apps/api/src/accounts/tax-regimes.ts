/**
 * A brokerage account's tax regime history (#508; migration 0028): one row per period, each in
 * force from its own `validFrom` until the next row's, the earliest also before it.
 * `@envelope/core`'s `validateTaxRegimeChange` checks the rules before anything is written;
 * migration 0028's primary key and trigger enforce the history rules in the database too, and a
 * violation of either is mapped to the same `ValidationError` code here. A change is also checked
 * against the account's trades it covers (`checkRegimeChange`, #653), under the same lock.
 */
import {
  checkAccountTradesAgainstRegime,
  checkRegimeChange,
  validateTaxRegimeChange,
  validateWithholdingAgentChange,
  ValidationError,
  type InstrumentType,
  type LocalDate,
  type RegimeCheckedTrade,
  type TaxKind,
  type TaxRegime,
  type TaxRegimeEntry,
  type TradeType,
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
 * or the workspace's tax country is not `IT`; the codes of `validateTaxRegimeChange`, where
 * "tax_regime_change_not_year_start" always names the requested date (#714), also when the new
 * period starts before the stored first one and so turns that one into a change;
 * "tax_regime_conflicts_with_trade" (details: tradeId, tradeDate, code) when the new history would
 * break a trade of the account (`checkRegimeChange`). Nothing is written then.
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
  const before = await loadHistory(db, workspaceId, accountId);
  await checkChange(db, workspaceId, accountId, account, before, [...before, entry], [entry]);
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
  await checkChange(db, workspaceId, accountId, account, await loadHistory(db, workspaceId, accountId), history);

  const sorted = [...history].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
  await db.query("DELETE FROM account_tax_regimes WHERE account_id = $1 AND workspace_id = $2", [accountId, workspaceId]);
  await insertEntries(db, workspaceId, accountId, sorted, account.type);
  return sorted;
}

/**
 * Sets a brokerage account's withholding-agent flag once, while it has none (#508: an account
 * created before its workspace's tax country became `IT`). Returns false if the account is not in
 * this workspace. When the account already has a regime history, its trades are checked against
 * the new flag (`checkAccountTradesAgainstRegime`, #653): a bond trade with domestic withholding
 * entered while the flag was unset refuses `false`. Without a history, the account's first regime
 * checks them (`checkRegimeChange`).
 *
 * @throws ValidationError from `@envelope/core`'s `validateWithholdingAgentChange`;
 *   "tax_regime_conflicts_with_trade" (details: tradeId, tradeDate, code). Nothing is written then.
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
  const history = await loadHistory(db, workspaceId, accountId);
  if (history.length > 0) {
    checkAccountTradesAgainstRegime(await loadTrades(db, workspaceId, accountId), { history, domesticWithholdingAgent });
  }
  await db.query("UPDATE accounts SET domestic_withholding_agent = $3 WHERE id = $1 AND workspace_id = $2", [
    accountId,
    workspaceId,
    domesticWithholdingAgent,
  ]);
  return true;
}

/**
 * Checks every trade of the workspace's brokerage accounts that have a regime history against it,
 * by the whole of `checkTradeRegime` (`checkAccountTradesAgainstRegime`, the rule of #653), when
 * the workspace's tax country becomes `IT` again (#667): trades written while it was another
 * country, or none, were not checked. An account with no history is left to its first regime,
 * which checks every trade (`checkRegimeChange`). Closed accounts are checked too.
 *
 * The caller holds the workspace row FOR NO KEY UPDATE, which a trade being written waits for
 * (trades/repository.ts, `checkRows`, FOR SHARE). The accounts are locked FOR NO KEY UPDATE in id
 * order, the order `checkRegimes` locks them FOR SHARE, so no regime change runs meanwhile.
 *
 * @throws ValidationError "tax_regime_conflicts_with_trade" (details: tradeId, tradeDate, code)
 *   for the first trade, by date then id across every account, that breaks a rule.
 */
export async function checkTradesAgainstRegimes(db: DbPool | DbClient, workspaceId: string): Promise<void> {
  const { rows } = await db.query<{ id: string; domestic_withholding_agent: boolean | null }>(
    `SELECT a.id, a.domestic_withholding_agent FROM accounts a
     WHERE a.workspace_id = $1 AND a.type = 'brokerage'
       AND EXISTS (SELECT 1 FROM account_tax_regimes r WHERE r.workspace_id = a.workspace_id AND r.account_id = a.id)
     ORDER BY a.id
     FOR NO KEY UPDATE OF a`,
    [workspaceId],
  );
  let first: ValidationError | undefined;
  for (const account of rows) {
    try {
      checkAccountTradesAgainstRegime(await loadTrades(db, workspaceId, account.id), {
        history: await loadHistory(db, workspaceId, account.id),
        domesticWithholdingAgent: account.domestic_withholding_agent,
      });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      if (first === undefined || comesBefore(error, first)) first = error;
    }
  }
  if (first !== undefined) throw first;
}

/** Whether the trade `a` names comes before the one `b` names, by date then id. */
function comesBefore(a: ValidationError, b: ValidationError): boolean {
  const key = (error: ValidationError): string => `${String(error.details.tradeDate)} ${String(error.details.tradeId)}`;
  return key(a) < key(b);
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

/**
 * Checks a change from `before` to `after`: the history's own rules (`validateTaxRegimeChange`),
 * then the account's trades the change covers (`checkRegimeChange`). The caller holds the
 * account's lock (`lockAccount`), which a trade being written also waits for before it reads the
 * history (trades/repository.ts, `checkRegimes`): no trade can slip in between this check and the
 * write.
 *
 * `requested` is the entries an addition brings (#714), left out for a replacement.
 *
 * @throws ValidationError the codes of `validateTaxRegimeChange`; "tax_regime_conflicts_with_trade".
 */
async function checkChange(
  db: DbPool | DbClient,
  workspaceId: string,
  accountId: string,
  account: LockedAccount,
  before: readonly TaxRegimeEntry[],
  after: readonly TaxRegimeEntry[],
  requested?: readonly TaxRegimeEntry[],
): Promise<void> {
  validateTaxRegimeChange({
    taxCountry: account.tax_country,
    domesticWithholdingAgent: account.domestic_withholding_agent,
    history: after,
    requested,
  });
  checkRegimeChange(await loadTrades(db, workspaceId, accountId), {
    before,
    after,
    domesticWithholdingAgent: account.domestic_withholding_agent,
  });
}

interface RegimeCheckedTradeRow {
  readonly id: string;
  readonly type: TradeType;
  readonly trade_date: string;
  readonly instrument_type: InstrumentType | null;
  readonly tax_kind: TaxKind | null;
  readonly cost_basis_cents: string | null;
  readonly gross_cents: string;
  readonly fees_cents: string;
  readonly transaction_tax_cents: string;
  readonly accrued_interest_cents: string;
  readonly withholding_foreign_cents: string;
  readonly withholding_domestic_cents: string;
  readonly gain_tax_cents: string;
}

/** The account's trades, with what `checkRegimeChange` reads of each. */
async function loadTrades(db: DbPool | DbClient, workspaceId: string, accountId: string): Promise<RegimeCheckedTrade[]> {
  const { rows } = await db.query<RegimeCheckedTradeRow>(
    `SELECT t.id, t.type, to_char(t.trade_date, 'YYYY-MM-DD') AS trade_date, i.type AS instrument_type, t.tax_kind,
            t.cost_basis_cents, t.gross_cents, t.fees_cents, t.transaction_tax_cents, t.accrued_interest_cents,
            t.withholding_foreign_cents, t.withholding_domestic_cents, t.gain_tax_cents
     FROM trades t LEFT JOIN instruments i ON i.id = t.instrument_id
     WHERE t.workspace_id = $1 AND t.account_id = $2`,
    [workspaceId, accountId],
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    date: row.trade_date,
    instrumentType: row.instrument_type,
    taxKind: row.tax_kind,
    costBasisCents: row.cost_basis_cents === null ? null : Number(row.cost_basis_cents),
    grossCents: Number(row.gross_cents),
    feesCents: Number(row.fees_cents),
    transactionTaxCents: Number(row.transaction_tax_cents),
    accruedInterestCents: Number(row.accrued_interest_cents),
    withholdingForeignCents: Number(row.withholding_foreign_cents),
    withholdingDomesticCents: Number(row.withholding_domestic_cents),
    gainTaxCents: Number(row.gain_tax_cents),
  }));
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
