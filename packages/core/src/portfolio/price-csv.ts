/**
 * A workspace's own closing prices, typed or read from a CSV file (#83, ADR 0019).
 *
 * A price is dated on a day that has already begun in the workspace's time
 * zone: today or earlier (#715). The CSV file has two columns, `date` and
 * `close`, in that order:
 *
 * ```csv
 * date,close
 * 2026-03-30,101.25
 * 2026-03-31,"101,50"
 * ```
 *
 * - the date is `YYYY-MM-DD`;
 * - the close is read like a price typed by the user (`parsePrice`): the
 *   locale's decimal separator, at most 6 decimals, never negative. A value
 *   that contains a comma is quoted, as in any CSV file;
 * - a first line reading `date,close` (any case) is a header and is skipped;
 *   blank lines are skipped;
 * - each date appears once.
 *
 * The file is accepted whole or refused whole: the first line that breaks a
 * rule refuses it, naming the line and the column, so nothing of a file that
 * was half right is ever stored. Pure, no file I/O, no user-facing text.
 */

import { ValidationError } from "../errors.ts";
import { splitCsvLine } from "../import/csv.ts";
import type { Locale } from "../money.ts";
import { assertDate, type LocalDate } from "../month.ts";
import { parsePrice, type Price } from "./quantity.ts";

/** The most data rows one price file may hold: about 80 years of daily closes. */
export const MAX_PRICE_CSV_ROWS = 20_000;

/** One closing price read from a file. */
export interface PriceCsvRow {
  readonly priceDate: LocalDate;
  readonly closeE6: Price;
}

/**
 * Why a line of a price file was refused, in the `reason` of an
 * `invalid_price_file` error:
 *
 * - `missing_column`, `extra_column`: the line does not have exactly two fields;
 * - `invalid_date`: not a real `YYYY-MM-DD` date, or a date after `today`
 *   (then `details.max` is `today`);
 * - `duplicate_date`: a date an earlier line already gave;
 * - `invalid_price_format`: not a price in the locale's format;
 * - `invalid_price`: a negative price, or one beyond the safe range;
 * - `no_rows`: the file holds no price at all.
 */
export type PriceFileProblem =
  | "missing_column"
  | "extra_column"
  | "invalid_date"
  | "duplicate_date"
  | "invalid_price_format"
  | "invalid_price"
  | "no_rows";

/**
 * Checks the date of a workspace's own price: a real date, no later than
 * `today` (the date in the workspace's time zone), with no lower limit (#715).
 *
 * @throws ValidationError `invalid_date` with `{ field: "date" }` for a
 *   malformed date, and with `{ field: "date", max: today }` for a later one.
 */
export function assertPriceDate(date: string, today: LocalDate): asserts date is LocalDate {
  assertDate(today);
  try {
    assertDate(date);
  } catch {
    throw new ValidationError("invalid_date", `not a valid YYYY-MM-DD date: "${date}"`, { field: "date" });
  }
  if (date > today) {
    throw new ValidationError("invalid_date", `a price cannot be dated after ${today}: "${date}"`, { field: "date", max: today });
  }
}

/**
 * The longest locale tag `assertLocale` accepts: a language, a script, a
 * region and a few variants fit well within it.
 */
export const MAX_LOCALE_LENGTH = 35;

/**
 * Checks a locale tag before it is used to read numbers: a well-formed tag of
 * at most `MAX_LOCALE_LENGTH` characters, with no extension (`-u-`, `-t-`…)
 * and no private-use (`-x-`) subtags. Those bounds keep the set of tags a
 * client can choose small, so that the separators cached per locale
 * (`money.ts`) cannot grow without limit.
 *
 * @throws ValidationError `invalid_locale` with `{ value }`.
 */
export function assertLocale(locale: string): asserts locale is Locale {
  let valid = locale.trim().length > 0 && locale.length <= MAX_LOCALE_LENGTH;
  if (valid) {
    try {
      const [canonical = ""] = Intl.getCanonicalLocales(locale);
      // A one-character subtag is a singleton: it opens an extension or a private-use sequence.
      valid = !canonical.split("-").some((subtag) => subtag.length === 1);
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    throw new ValidationError("invalid_locale", `not a locale tag: "${locale}"`, { value: locale });
  }
}

function refuse(line: number, column: number, reason: PriceFileProblem, extra: Readonly<Record<string, string>> = {}): ValidationError {
  return new ValidationError("invalid_price_file", `line ${line}, column ${column}: ${reason}`, { line, column, reason, ...extra });
}

function isHeader(fields: readonly string[]): boolean {
  return fields.length === 2 && fields[0]!.trim().toLowerCase() === "date" && fields[1]!.trim().toLowerCase() === "close";
}

/**
 * Reads a CSV file of closing prices (the module's description gives its
 * format) into one row per date, in the file's order.
 *
 * @example parsePriceCsv("date,close\n2026-03-31,\"101,5\"\n", { locale: "it-IT", today: "2026-04-01" })
 *   // [{ priceDate: "2026-03-31", closeE6: 101500000 }]
 * @throws ValidationError `invalid_locale` for a locale tag that is not one;
 *   `too_many_rows` with `{ max }` for a file of more than `MAX_PRICE_CSV_ROWS`
 *   data rows, before any row is read; `invalid_price_file` with
 *   `{ line, column, reason }` (1-based, counting every line of the file, the
 *   header and blank lines included) for the first line that breaks a rule,
 *   plus `max` (`today`) for a line dated after today.
 */
export function parsePriceCsv(text: string, options: { readonly locale: Locale; readonly today: LocalDate }): PriceCsvRow[] {
  assertLocale(options.locale);
  assertDate(options.today);
  const lines = (text.startsWith("﻿") ? text.slice(1) : text).split(/\r\n|\r|\n/);

  const numbered = lines.flatMap((content, index) => (content.trim().length > 0 ? [{ content, line: index + 1 }] : []));
  const first = numbered[0];
  const data = first !== undefined && isHeader(splitCsvLine(first.content)) ? numbered.slice(1) : numbered;
  if (data.length > MAX_PRICE_CSV_ROWS) {
    throw new ValidationError("too_many_rows", `a price file holds at most ${MAX_PRICE_CSV_ROWS} rows`, { max: MAX_PRICE_CSV_ROWS });
  }
  if (data.length === 0) {
    throw refuse(first?.line ?? 1, 1, "no_rows");
  }

  const seen = new Set<string>();
  return data.map(({ content, line }) => {
    const fields = splitCsvLine(content);
    if (fields.length < 2) {
      throw refuse(line, 2, "missing_column");
    }
    if (fields.length > 2) {
      throw refuse(line, 3, "extra_column");
    }
    const priceDate = fields[0]!.trim();
    try {
      assertPriceDate(priceDate, options.today);
    } catch (error) {
      if (error instanceof ValidationError && error.code === "invalid_date") {
        const { max } = error.details;
        throw refuse(line, 1, "invalid_date", typeof max === "string" ? { max } : {});
      }
      throw error;
    }
    if (seen.has(priceDate)) {
      throw refuse(line, 1, "duplicate_date");
    }
    seen.add(priceDate);

    let closeE6: Price;
    try {
      closeE6 = parsePrice(fields[1]!.trim(), { locale: options.locale });
    } catch (error) {
      if (error instanceof ValidationError && (error.code === "invalid_price_format" || error.code === "invalid_price")) {
        throw refuse(line, 2, error.code);
      }
      throw error;
    }
    return { priceDate, closeE6 };
  });
}
