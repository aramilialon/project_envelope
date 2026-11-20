/**
 * Instruments of the shared catalog (design.md, "Portfolio module" and "Data model"): validation
 * and normalization of what a user types when adding one. Pure: no database, no user-facing text,
 * only `ValidationError`s with a stable `code` (ADR 0004).
 */
import { ValidationError } from "../errors.ts";
import { PRICE_FACTOR_ONE, toPriceFactor, type PriceFactor } from "./quantity.ts";

/**
 * design.md's "ETFs, stocks, bonds, funds, cash", split along the lines tax rules draw, because a
 * catalog row can never be updated once other workspaces reference it: `fund` (ETFs included,
 * whose gains are taxed differently from shares'), `etc_etn` (exchange-traded commodities and
 * notes, taxed like shares), `government_bond` (government, white-listed-state or supranational
 * issuers, which may have a reduced rate) apart from every other `bond`, and `certificate`.
 */
export const INSTRUMENT_TYPES = [
  "stock",
  "fund",
  "etc_etn",
  "government_bond",
  "bond",
  "certificate",
  "cash",
  "other",
] as const;
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

export function isInstrumentType(value: string): value is InstrumentType {
  return (INSTRUMENT_TYPES as readonly string[]).includes(value);
}

/**
 * Longest value each free-text field accepts, counted after control and format characters are
 * stripped; the same limits are `CHECK` constraints in migration 0026. A JavaScript length counts
 * UTF-16 code units, never fewer than PostgreSQL's `char_length` characters, so a value accepted
 * here always fits the column.
 */
export const INSTRUMENT_FIELD_MAX_LENGTH = {
  name: 200,
  assetClass: 64,
} as const;
export type InstrumentTextField = keyof typeof INSTRUMENT_FIELD_MAX_LENGTH;

/**
 * A ticker after upper-casing: ASCII letters, digits, dots and hyphens only, 1 to 32 characters.
 * Checked after upper-casing, which can lengthen a string ("ß" becomes "SS").
 */
const TICKER_FORMAT = /^[A-Z0-9.\-]{1,32}$/;

/**
 * An exchange is its ISO 10383 market identifier code (MIC), such as XMIL or XETR: exactly four
 * ASCII letters or digits, so "XMIL" and "MIL" can never become two listings of the same security,
 * and no lookalike Unicode letter can either.
 */
const MIC_FORMAT = /^[A-Z0-9]{4}$/;

/** Unicode control (Cc) and format (Cf) characters: invisible, so stripped from free text. */
const CONTROL_AND_FORMAT = /[\p{Cc}\p{Cf}]/gu;

const ISIN_FORMAT = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/**
 * The ISIN check digit (ISO 6166) of an ISIN's first 11 characters: every letter becomes two
 * digits (A = 10 ... Z = 35), then the Luhn algorithm runs over the resulting digit string.
 */
export function isinCheckDigit(body: string): number {
  let digits = "";
  for (const char of body) {
    const code = char.charCodeAt(0);
    digits += code >= 65 && code <= 90 ? String(code - 55) : char;
  }
  let sum = 0;
  // The rightmost digit of `digits` sits next to the (not yet known) check digit, so it is the
  // one Luhn doubles first.
  for (let i = 0; i < digits.length; i++) {
    let value = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
  }
  return (10 - (sum % 10)) % 10;
}

/** True if `isin` is two letters, nine letters or digits, and a correct check digit. Case-sensitive: normalize first. */
export function isValidIsin(isin: string): boolean {
  return ISIN_FORMAT.test(isin) && isinCheckDigit(isin.slice(0, 11)) === Number(isin[11]);
}

/** @throws ValidationError `invalid_isin` if `isin` is not a valid ISIN. */
export function assertIsin(isin: string): void {
  if (!isValidIsin(isin)) {
    throw new ValidationError("invalid_isin", `"${isin}" is not a valid ISIN`, { isin });
  }
}

export interface InstrumentInput {
  readonly isin?: string | null | undefined;
  readonly ticker?: string | null | undefined;
  readonly exchange?: string | null | undefined;
  readonly name: string;
  readonly type: string;
  readonly currency: string;
  readonly assetClass?: string | null | undefined;
  /**
   * The price factor × 10^6 ([ADR 0011](../../../../docs/adr/0011-quantities-and-prices-as-scaled-integers.md)).
   * Not narrowed to `number`: a caller passes on whatever JSON value it received, and this checks it.
   */
  readonly priceFactorE6?: unknown;
}

export interface NormalizedInstrument {
  readonly isin: string | null;
  readonly ticker: string | null;
  readonly exchange: string | null;
  readonly name: string;
  readonly type: InstrumentType;
  readonly currency: string;
  readonly assetClass: string | null;
  /** `PRICE_FACTOR_ONE`, or `PRICE_FACTOR_HUNDREDTH` for a bond quoted in percent of nominal or a price in pence. */
  readonly priceFactorE6: PriceFactor;
}

function optionalText(value: string | null | undefined, field: InstrumentTextField): string | null {
  const trimmed = value?.replace(CONTROL_AND_FORMAT, "").trim() ?? "";
  if (trimmed === "") return null;
  if (trimmed.length > INSTRUMENT_FIELD_MAX_LENGTH[field]) {
    throw new ValidationError("invalid_instrument_field", `${field} is longer than ${INSTRUMENT_FIELD_MAX_LENGTH[field]} characters`, {
      field,
      maxLength: INSTRUMENT_FIELD_MAX_LENGTH[field],
    });
  }
  return trimmed;
}

/**
 * Trims every field, strips control and format characters from the name and asset class,
 * upper-cases the ISIN, ticker, exchange and currency, turns empty optional fields into `null`, and
 * validates the result. An instrument is a listing: it needs an ISIN, or a ticker on an exchange
 * (no private instruments in the shared catalog yet), and a ticker always needs its exchange.
 *
 * @throws ValidationError `invalid_instrument_field` (a missing name, or a name or asset class too
 *   long), `missing_instrument_identifier` (neither an ISIN nor a ticker), `missing_exchange` (a
 *   ticker with no exchange), `invalid_isin`, `invalid_ticker`, `invalid_exchange`,
 *   `invalid_instrument_type`, `invalid_currency` or `invalid_price_factor` (details
 *   `{ label: "priceFactorE6", value }`, the same shape as `assertPriceFactor`'s).
 */
export function normalizeInstrument(input: InstrumentInput): NormalizedInstrument {
  const name = optionalText(input.name, "name");
  if (name === null) {
    throw new ValidationError("invalid_instrument_field", "name is required", { field: "name" });
  }

  const isin = input.isin?.trim().toUpperCase() || null;
  if (isin !== null) assertIsin(isin);

  const type = input.type.trim();
  if (!isInstrumentType(type)) {
    throw new ValidationError("invalid_instrument_type", `"${input.type}" is not an instrument type`, { type: input.type });
  }

  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError("invalid_currency", `"${input.currency}" is not a known currency code`, {
      currency: input.currency,
    });
  }

  const priceFactorE6 = normalizePriceFactorE6(input.priceFactorE6);

  const ticker = input.ticker?.trim().toUpperCase() || null;
  if (ticker !== null && !TICKER_FORMAT.test(ticker)) {
    throw new ValidationError("invalid_ticker", `"${input.ticker}" is not a ticker`, { ticker: String(input.ticker) });
  }
  const exchange = input.exchange?.trim().toUpperCase() || null;
  if (exchange !== null && !MIC_FORMAT.test(exchange)) {
    throw new ValidationError("invalid_exchange", `"${input.exchange}" is not a market identifier code`, {
      exchange: String(input.exchange),
    });
  }
  if (isin === null && ticker === null) {
    throw new ValidationError("missing_instrument_identifier", "an instrument needs an ISIN, or a ticker and an exchange");
  }
  if (ticker !== null && exchange === null) {
    throw new ValidationError("missing_exchange", "a ticker needs its exchange", { ticker });
  }

  return {
    isin,
    ticker,
    exchange,
    name,
    type,
    currency,
    assetClass: optionalText(input.assetClass, "assetClass"),
    priceFactorE6,
  };
}

/** A missing factor is 1; anything but a number is rejected before `toPriceFactor` sees it. */
function normalizePriceFactorE6(value: unknown): PriceFactor {
  if (value === undefined || value === null) return PRICE_FACTOR_ONE;
  if (typeof value !== "number") {
    throw new ValidationError("invalid_price_factor", `priceFactorE6 is not a number: ${String(value)}`, {
      label: "priceFactorE6",
      value: String(value),
    });
  }
  return toPriceFactor(value, "priceFactorE6");
}

/**
 * Shortest ticker or name prefix a search accepts. For usability, not confidentiality: a shorter
 * prefix would mostly return noise. The catalog is shared, and any signed-in user can still read
 * all of it by trying every prefix.
 */
export const INSTRUMENT_SEARCH_MIN_PREFIX = 2;

export type InstrumentSearch =
  | { readonly kind: "isin"; readonly isin: string }
  | { readonly kind: "prefix"; readonly prefix: string };

/**
 * What a catalog search looks for: an exact ISIN when the query is one (check digit included),
 * otherwise a ticker or name prefix of at least `INSTRUMENT_SEARCH_MIN_PREFIX` characters. There is
 * no "everything" search; the minimum length and the API's result limit keep answers short and
 * useful, they do not hide the catalog (see `INSTRUMENT_SEARCH_MIN_PREFIX`).
 *
 * @throws ValidationError `search_query_too_short` with `minLength` in details.
 */
export function parseInstrumentSearch(query: string): InstrumentSearch {
  const trimmed = query.trim();
  const upper = trimmed.toUpperCase();
  if (isValidIsin(upper)) {
    return { kind: "isin", isin: upper };
  }
  if (trimmed.length < INSTRUMENT_SEARCH_MIN_PREFIX) {
    throw new ValidationError("search_query_too_short", `a search needs an ISIN or at least ${INSTRUMENT_SEARCH_MIN_PREFIX} characters`, {
      minLength: INSTRUMENT_SEARCH_MIN_PREFIX,
    });
  }
  return { kind: "prefix", prefix: trimmed };
}
