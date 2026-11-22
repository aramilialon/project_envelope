/**
 * Reading the euro reference rates file the European Central Bank publishes (#85, ADR 0019).
 *
 * The file is XML, in one of two layouts that differ only in white space and quotes: the daily
 * file (one day, single quotes, one entry per line) and the history files (every day since 1999,
 * or the last 90 days; double quotes, all on one line). Both nest the rates the same way:
 *
 *     <Cube>
 *       <Cube time="2026-11-20">
 *         <Cube currency="USD" rate="1.0990"/>
 *         …
 *       </Cube>
 *       …
 *     </Cube>
 *
 * Only these `Cube` elements are read, in one pass over the text, with no XML library: the rest
 * of the file (the envelope, the sender) carries nothing the app stores. The file is refused as a
 * whole, never in part, when anything in that structure is not exactly as above: a truncated
 * download, an entry outside a day, a rate that is not a plain decimal number, a date that is not
 * a calendar date, a day or a currency given twice. A rate is turned into `rateE10` (units of the
 * currency for one euro × 10^10) from its decimal text, digit by digit, never through a float; a
 * rate with more than 10 decimals is refused, never rounded.
 *
 * Only the currencies the app can hold are returned (`isKnownCurrency`: ISO 4217 codes still in
 * use). The history file also lists the currencies the euro and others replaced (the Cypriot
 * pound, the old Turkish lira…); their entries are checked like the others, then left out and
 * named in `skippedCurrencies`. They are never range-checked: the old Turkish lira, at almost
 * two million for one euro, is beyond the safe range of `rateE10`, and no account or instrument
 * can be in it.
 *
 * Pure: the caller fetches or reads the file.
 */

import { ValidationError } from "../errors.ts";
import type { CurrencyCode } from "../money.ts";
import { isKnownCurrency } from "../money.ts";
import type { LocalDate } from "../month.ts";
import { assertDate } from "../month.ts";
import type { FxRate } from "./fx.ts";
import { FX_BASE_CURRENCY, FX_RATE_DECIMALS } from "./fx.ts";

/**
 * The largest file read, in characters (the file is ASCII, so in bytes too). The full history
 * since 1999 is about 8 MB in 2026 and grows by about 1.2 kB a day.
 */
export const ECB_RATES_FILE_MAX_CHARS = 32 * 1024 * 1024;

/** Why a rates file was refused: `details.reason` of `invalid_rates_file`. */
export type EcbRatesFileProblem =
  | "too_large"
  | "malformed"
  | "invalid_date"
  | "duplicate_date"
  | "duplicate_rate"
  | "rate_out_of_range"
  | "no_rates";

/** The rates read from one file. */
export interface EcbReferenceRates {
  /** Every rate of a currency the app can hold, in the file's order. */
  readonly rates: readonly FxRate[];
  /** The currencies the file lists that the app cannot hold, sorted, each once. */
  readonly skippedCurrencies: readonly string[];
}

const RATE_ONE = 10n ** BigInt(FX_RATE_DECIMALS);
const MAX_RATE_E10 = BigInt(Number.MAX_SAFE_INTEGER);
/** A plain decimal number: digits, then optionally a point and at most FX_RATE_DECIMALS digits. */
const RATE_TEXT = new RegExp(`^(\\d{1,16})(?:\\.(\\d{1,${FX_RATE_DECIMALS}}))?$`);
const CURRENCY_TEXT = /^[A-Z]{3}$/;
/** One `Cube` tag: opening, closing or self-closing, with its attribute text. */
const CUBE_TAG = /<(\/?)Cube\b([^<>]*?)(\/?)>/g;
/** One attribute, in single or double quotes, read from where the previous one ended. */
const ATTRIBUTE = /\s+([A-Za-z]+)\s*=\s*(?:'([^'<>]*)'|"([^"<>]*)")/y;

function refuse(reason: EcbRatesFileProblem, message: string, details: Record<string, string | number> = {}): ValidationError {
  return new ValidationError("invalid_rates_file", message, { reason, ...details });
}

/** The attributes of one tag, or null when the text between `Cube` and `>` is not only attributes. */
function readAttributes(text: string): Map<string, string> | null {
  const attributes = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  let end = 0;
  for (;;) {
    const match = ATTRIBUTE.exec(text);
    if (match === null) break;
    const name = match[1] as string;
    if (attributes.has(name)) return null;
    attributes.set(name, match[2] ?? match[3] ?? "");
    end = ATTRIBUTE.lastIndex;
  }
  return /^\s*$/.test(text.slice(end)) ? attributes : null;
}

function hasOnly(attributes: Map<string, string>, names: readonly string[]): boolean {
  return attributes.size === names.length && names.every((name) => attributes.has(name));
}

/**
 * Reads every rate in an ECB euro reference rates file (the daily file, the 90-day file or the
 * full history).
 *
 * @example
 *   parseEcbReferenceRates(dailyFileText).rates[0]
 *   // { base: "EUR", quote: "USD", date: "2026-11-20", rateE10: 10990000000 }
 *
 * @throws ValidationError "invalid_rates_file", the whole file refused, with `details.reason`
 *   (`EcbRatesFileProblem`) and, where there is one, `offset` (the character where the problem
 *   is), `date` and `currency`: `too_large` beyond `ECB_RATES_FILE_MAX_CHARS`; `malformed` for a
 *   tag, nesting or rate text that is not as described above, a truncated file included;
 *   `invalid_date`; `duplicate_date` and `duplicate_rate`; `rate_out_of_range` for a rate of a
 *   currency the app holds that is zero or beyond the safe range once × 10^10; `no_rates` for a
 *   file with no rate in it.
 */
export function parseEcbReferenceRates(text: string): EcbReferenceRates {
  if (text.length > ECB_RATES_FILE_MAX_CHARS) {
    throw refuse("too_large", `the rates file is larger than ${ECB_RATES_FILE_MAX_CHARS} characters`, {
      max: ECB_RATES_FILE_MAX_CHARS,
    });
  }

  const rates: FxRate[] = [];
  const skipped = new Set<string>();
  const seenDates = new Set<LocalDate>();
  let entries = 0;
  // 0: before the outer Cube; 1: inside it; 2: inside a day; 3: after the outer Cube closed.
  let depth = 0;
  let day: LocalDate | null = null;
  let dayCurrencies = new Set<string>();

  CUBE_TAG.lastIndex = 0;
  for (;;) {
    const tag = CUBE_TAG.exec(text);
    if (tag === null) break;
    const offset = tag.index;
    const closing = tag[1] === "/";
    const selfClosing = tag[3] === "/";
    const attributes = readAttributes(tag[2] ?? "");
    const malformed = (what: string): ValidationError => refuse("malformed", `${what} at character ${offset}`, { offset });
    if (attributes === null || (closing && (selfClosing || attributes.size > 0))) {
      throw malformed("a Cube tag that is not well formed");
    }

    if (closing) {
      if (depth === 2) {
        depth = 1;
        day = null;
      } else if (depth === 1) {
        depth = 3;
      } else {
        throw malformed("a closing Cube tag with nothing open");
      }
      continue;
    }

    if (depth === 0 && !selfClosing && attributes.size === 0) {
      depth = 1;
    } else if (depth === 1 && !selfClosing && hasOnly(attributes, ["time"])) {
      const date = attributes.get("time") as string;
      try {
        assertDate(date);
      } catch {
        throw refuse("invalid_date", `not a calendar date at character ${offset}: ${date}`, { offset, date });
      }
      if (seenDates.has(date)) {
        throw refuse("duplicate_date", `the day ${date} is given twice`, { offset, date });
      }
      seenDates.add(date);
      day = date;
      dayCurrencies = new Set();
      depth = 2;
    } else if (depth === 2 && selfClosing && hasOnly(attributes, ["currency", "rate"]) && day !== null) {
      const currency = attributes.get("currency") as string;
      const rateText = attributes.get("rate") as string;
      const digits = RATE_TEXT.exec(rateText);
      if (!CURRENCY_TEXT.test(currency) || currency === FX_BASE_CURRENCY || digits === null) {
        throw malformed("a rate entry that is not a currency code and a decimal number");
      }
      if (dayCurrencies.has(currency)) {
        throw refuse("duplicate_rate", `${currency} is given twice on ${day}`, { offset, date: day, currency });
      }
      dayCurrencies.add(currency);
      entries++;
      if (!isKnownCurrency(currency)) {
        skipped.add(currency);
        continue;
      }
      const fraction = (digits[2] ?? "").padEnd(FX_RATE_DECIMALS, "0");
      const rateE10 = BigInt(digits[1] as string) * RATE_ONE + BigInt(fraction);
      if (rateE10 < 1n || rateE10 > MAX_RATE_E10) {
        throw refuse("rate_out_of_range", `the rate of ${currency} on ${day} is zero or too large to store: ${rateText}`, {
          offset,
          date: day,
          currency,
        });
      }
      rates.push({ base: FX_BASE_CURRENCY, quote: currency as CurrencyCode, date: day, rateE10: Number(rateE10) });
    } else {
      throw malformed("a Cube tag where none is expected");
    }
  }

  if (depth !== 3 && depth !== 0) {
    throw refuse("malformed", "the rates file ends before its Cube elements are closed", { offset: text.length });
  }
  if (entries === 0) {
    throw refuse("no_rates", "the rates file holds no rate");
  }
  return { rates, skippedCurrencies: [...skipped].sort() };
}
