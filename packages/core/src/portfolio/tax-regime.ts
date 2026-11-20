/**
 * The tax regime a brokerage account is under, over time (#508).
 *
 * An account keeps a history of regimes rather than a single value, so a later change never
 * reinterprets trades already recorded: a trade uses the regime in force on its own date. The
 * first entry may start on any date, and also covers every date before it; every later one
 * starts on 1 January, the only day a change takes effect. No two entries share a date.
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

/** Tax countries whose rules need every brokerage account's regime and withholding agent; others are added with their own rules. */
const COUNTRIES_REQUIRING_REGIME: readonly string[] = ["IT"];

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
 * Checks the tax settings given when an account is created: only a brokerage account takes a
 * regime or a withholding-agent flag, and in a workspace whose tax country needs them (Italy
 * today) a brokerage account must have both.
 *
 * @throws ValidationError "tax_regime_not_applicable" (details.field names the setting) for a
 * setting given on an account that is not a brokerage account; "tax_regime_required" (details.field
 * names the missing one) for a brokerage account missing one its workspace's tax country needs.
 */
export function validateAccountTaxSettings(settings: AccountTaxSettings): void {
  const isBrokerage = settings.accountType === "brokerage";
  const needsBoth = isBrokerage && settings.taxCountry !== null && COUNTRIES_REQUIRING_REGIME.includes(settings.taxCountry);
  for (const field of ["taxRegime", "domesticWithholdingAgent"] as const) {
    const given = settings[field] !== undefined;
    if (given && !isBrokerage) {
      throw new ValidationError("tax_regime_not_applicable", `only a brokerage account takes ${field}`, {
        field,
        type: settings.accountType,
      });
    }
    if (!given && needsBoth) {
      throw new ValidationError("tax_regime_required", `a brokerage account needs ${field} in this tax country`, {
        field,
        taxCountry: settings.taxCountry ?? "",
      });
    }
  }
}

function sortByValidFrom(history: readonly TaxRegimeEntry[]): TaxRegimeEntry[] {
  return [...history].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
}
