/**
 * The tax regime a brokerage account is under, over time (#508).
 *
 * An account keeps a history of regimes rather than a single value: a trade uses the regime in
 * force on its own date, so a change from a later 1 January does not alter trades dated before
 * it; recording or correcting the history re-reads the trades it covers. The first entry may
 * start on any date, and also covers every date before it; every later one starts on 1 January,
 * the only day a change takes effect. No two entries share a date.
 *
 * Only the rules about the history live here. What each regime means for taxes is computed
 * elsewhere, later (design.md, "Portfolio module").
 */
import { ValidationError } from "../errors.ts";
import { assertDate, type LocalDate } from "../month.ts";

/** `self_declared`: the investor declares gains; `administered`: the broker withholds as it goes; `managed`: a discretionary mandate. */
export type TaxRegime = "self_declared" | "administered" | "managed";

export const TAX_REGIMES: readonly TaxRegime[] = ["self_declared", "administered", "managed"];

export interface TaxRegimeEntry {
  /** The first day this regime applies, "YYYY-MM-DD". */
  readonly validFrom: LocalDate;
  readonly regime: TaxRegime;
}

export function isTaxRegime(value: unknown): value is TaxRegime {
  return typeof value === "string" && (TAX_REGIMES as readonly string[]).includes(value);
}

/**
 * Checks a whole regime history, in any order.
 *
 * @throws ValidationError "invalid_date" for a date that is not a real "YYYY-MM-DD" date;
 * "tax_regime_duplicate_date" if two entries start on the same day;
 * "tax_regime_change_not_year_start" if an entry other than the earliest does not start on 1 January.
 */
export function validateTaxRegimeHistory(history: readonly TaxRegimeEntry[]): void {
  for (const entry of history) {
    assertDate(entry.validFrom);
  }
  const sorted = sortByValidFrom(history);
  for (let index = 1; index < sorted.length; index++) {
    const entry = sorted[index]!;
    if (entry.validFrom === sorted[index - 1]!.validFrom) {
      throw new ValidationError("tax_regime_duplicate_date", `two tax regimes start on ${entry.validFrom}`, {
        validFrom: entry.validFrom,
      });
    }
    if (!entry.validFrom.endsWith("-01-01")) {
      throw new ValidationError(
        "tax_regime_change_not_year_start",
        `a tax regime change must start on 1 January, not ${entry.validFrom}`,
        { validFrom: entry.validFrom },
      );
    }
  }
}

/**
 * The regime in force on `date`: the entry with the latest `validFrom` on or before it. The
 * first entry also applies to every earlier date: before the first recorded change, the initial
 * regime is the only one known, so trades older than the day it was recorded still have one.
 * `undefined` only when the history is empty.
 *
 * @throws ValidationError "invalid_date" if `date` is not a real "YYYY-MM-DD" date.
 */
export function regimeAt(history: readonly TaxRegimeEntry[], date: LocalDate): TaxRegime | undefined {
  assertDate(date);
  let found: TaxRegimeEntry | undefined;
  let first: TaxRegimeEntry | undefined;
  for (const entry of history) {
    // "YYYY-MM-DD" strings compare in calendar order.
    if (entry.validFrom <= date && (found === undefined || entry.validFrom > found.validFrom)) {
      found = entry;
    }
    if (first === undefined || entry.validFrom < first.validFrom) {
      first = entry;
    }
  }
  return (found ?? first)?.regime;
}

/**
 * The tax country these regimes and the withholding-agent flag belong to: they are Italian
 * rules, required in an `IT` workspace and refused anywhere else. Other countries are added
 * with their own rules.
 */
export const TAX_REGIME_COUNTRY = "IT";

/** Regimes in which the broker settles the tax itself, so it must be an Italian withholding agent. */
const REGIMES_NEEDING_WITHHOLDING_AGENT: readonly TaxRegime[] = ["administered", "managed"];

/**
 * Checks that the account's withholding-agent flag allows every regime given: `administered` and
 * `managed` need a broker that is an Italian withholding agent (`domesticWithholdingAgent` true);
 * `self_declared` takes either.
 *
 * @throws ValidationError "tax_regime_requires_withholding_agent" (details.regime) otherwise.
 */
export function assertWithholdingAgentFor(regimes: readonly TaxRegime[], domesticWithholdingAgent: boolean | null | undefined): void {
  for (const regime of regimes) {
    if (REGIMES_NEEDING_WITHHOLDING_AGENT.includes(regime) && domesticWithholdingAgent !== true) {
      throw new ValidationError(
        "tax_regime_requires_withholding_agent",
        `the ${regime} regime needs a broker that is a domestic withholding agent`,
        { regime },
      );
    }
  }
}

export interface AccountTaxSettings {
  /** The account's type, as stored ("checking", "brokerage", ...). */
  readonly accountType: string;
  /** The workspace's tax country (ISO 3166-1 alpha-2), or null if it has none. */
  readonly taxCountry: string | null;
  readonly taxRegime?: TaxRegime | undefined;
  /** Whether the broker is a domestic withholding agent. */
  readonly domesticWithholdingAgent?: boolean | undefined;
}

/**
 * Checks the tax settings given when an account is created: only a brokerage account in an `IT`
 * workspace takes a regime or a withholding-agent flag, and there it must have both, the flag
 * true for an administered or managed regime.
 *
 * @throws ValidationError "tax_regime_not_applicable" (details.field names the setting) for a
 * setting given on an account that is not a brokerage account (details.type) or in a workspace
 * whose tax country is not `IT` (details.taxCountry, "" when none); "tax_regime_required"
 * (details.field names the missing one) for a brokerage account in an `IT` workspace missing one;
 * "tax_regime_requires_withholding_agent" from `assertWithholdingAgentFor`.
 */
export function validateAccountTaxSettings(settings: AccountTaxSettings): void {
  const isBrokerage = settings.accountType === "brokerage";
  const inTaxCountry = settings.taxCountry === TAX_REGIME_COUNTRY;
  for (const field of ["taxRegime", "domesticWithholdingAgent"] as const) {
    const given = settings[field] !== undefined;
    if (given && !isBrokerage) {
      throw new ValidationError("tax_regime_not_applicable", `only a brokerage account takes ${field}`, {
        field,
        type: settings.accountType,
      });
    }
    if (given && !inTaxCountry) {
      throw notInTaxCountryError(field, settings.taxCountry);
    }
    if (!given && isBrokerage && inTaxCountry) {
      throw new ValidationError("tax_regime_required", `a brokerage account needs ${field} in this tax country`, {
        field,
        taxCountry: TAX_REGIME_COUNTRY,
      });
    }
  }
  if (settings.taxRegime !== undefined) {
    assertWithholdingAgentFor([settings.taxRegime], settings.domesticWithholdingAgent);
  }
}

export interface TaxRegimeChange {
  /** The workspace's tax country, or null if it has none. */
  readonly taxCountry: string | null;
  /** The account's flag as stored: null for an account created before its workspace became `IT`. */
  readonly domesticWithholdingAgent: boolean | null;
  /** The whole history once the change is applied. */
  readonly history: readonly TaxRegimeEntry[];
}

/**
 * Checks a brokerage account's regime history once a period is added or the whole history is
 * replaced: regimes only in an `IT` workspace, where the history may not be emptied; the rules of
 * `validateTaxRegimeHistory`; and the withholding-agent flag every regime in it needs.
 *
 * @throws ValidationError "tax_regime_not_applicable" outside an `IT` workspace;
 * "tax_regime_required" for an empty history in one; the codes of `validateTaxRegimeHistory`
 * and `assertWithholdingAgentFor`.
 */
export function validateTaxRegimeChange(change: TaxRegimeChange): void {
  const inTaxCountry = change.taxCountry === TAX_REGIME_COUNTRY;
  if (change.history.length > 0 && !inTaxCountry) {
    throw notInTaxCountryError("taxRegime", change.taxCountry);
  }
  if (change.history.length === 0 && inTaxCountry) {
    throw new ValidationError("tax_regime_required", "a brokerage account needs a tax regime in this tax country", {
      field: "taxRegime",
      taxCountry: TAX_REGIME_COUNTRY,
    });
  }
  validateTaxRegimeHistory(change.history);
  assertWithholdingAgentFor(
    change.history.map((entry) => entry.regime),
    change.domesticWithholdingAgent,
  );
}

export interface WithholdingAgentChange {
  readonly accountType: string;
  readonly taxCountry: string | null;
  /** The flag as stored now. */
  readonly current: boolean | null;
}

/**
 * Checks that an account's withholding-agent flag may be set now. The flag is fixed per account:
 * it can only be set once, on a brokerage account in an `IT` workspace that has none yet (one
 * created before its workspace became `IT`). A change of the broker's status is a new account.
 *
 * @throws ValidationError "tax_regime_not_applicable" for an account that is not a brokerage
 * account or a workspace whose tax country is not `IT`; "withholding_agent_already_set" once the
 * flag has a value.
 */
export function validateWithholdingAgentChange(change: WithholdingAgentChange): void {
  if (change.accountType !== "brokerage") {
    throw new ValidationError("tax_regime_not_applicable", "only a brokerage account takes domesticWithholdingAgent", {
      field: "domesticWithholdingAgent",
      type: change.accountType,
    });
  }
  if (change.taxCountry !== TAX_REGIME_COUNTRY) {
    throw notInTaxCountryError("domesticWithholdingAgent", change.taxCountry);
  }
  if (change.current !== null) {
    throw new ValidationError("withholding_agent_already_set", "the withholding-agent flag is fixed once set", {
      field: "domesticWithholdingAgent",
    });
  }
}

function notInTaxCountryError(field: string, taxCountry: string | null): ValidationError {
  return new ValidationError("tax_regime_not_applicable", `${field} applies only in a workspace whose tax country is IT`, {
    field,
    taxCountry: taxCountry ?? "",
  });
}

function sortByValidFrom(history: readonly TaxRegimeEntry[]): TaxRegimeEntry[] {
  return [...history].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
}
