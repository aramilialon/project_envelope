/**
 * OFX import (design.md, "Import and reconciliation"): self-describing, no
 * column mapping. Each `<STMTTRN>` becomes the same normalized `ImportRow`
 * shape the CSV importer produces (#28), before duplicate detection.
 *
 * OFX 1.x is SGML: most tags are never closed (`<FITID>123`, not
 * `<FITID>123</FITID>`), ending only at the next tag or line break. OFX 2.x
 * is plain XML, always closed. The tag reader below handles both the same
 * way: it stops at the next "<" or line break either way, so it never has to
 * know which version it is reading. `<STMTTRN>` itself, an aggregate (a
 * container of other tags, not a value), is always closed in both versions.
 *
 * Pure, no file I/O: the caller reads the upload and passes its text content here.
 */

import { ValidationError } from "../errors.ts";
import type { Cents, CurrencyCode } from "../money.ts";
import { assertDate, type LocalDate } from "../month.ts";
import { assertFileCurrency, scaleDecimalAmount } from "./parsing.ts";
import type { ImportOptions, ImportRow } from "./row.ts";
import { findTagBlocks } from "./tag-blocks.ts";

function extractTag(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<\r\n]*)`, "i").exec(block);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

function parseOfxDate(text: string): LocalDate {
  // "20260915120000[+1:CET]" or "20260915": only the leading YYYYMMDD matters here.
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(text);
  if (!match) {
    throw new ValidationError("invalid_date", `not a valid OFX DTPOSTED: "${text}"`, { value: text });
  }
  const [, year, month, day] = match as unknown as [string, string, string, string];
  const date = `${year}-${month}-${day}`;
  assertDate(date);
  return date;
}

function parseOfxAmount(text: string, currency: CurrencyCode): Cents {
  const amount = scaleDecimalAmount(text.replace(/^\+/, ""), currency);
  if (amount === null) {
    throw new ValidationError("invalid_amount_format", `not a valid OFX TRNAMT: "${text}"`, { text });
  }
  return amount;
}

/**
 * Every statement's `<CURDEF>`, the currency its amounts are in: one per statement
 * (`<STMTRS>`, `<CCSTMTRS>`), and a file may hold several.
 */
function statedCurrencies(content: string): string[] {
  // No nested quantifier and no backtracking past a "<" or line break: linear in the file (#675).
  return Array.from(content.matchAll(/<CURDEF>([^<\r\n]*)/gi), (match) => match[1] ?? "");
}

/**
 * The currency a `<STMTTRN>` states for its own amount, in `<CURRENCY><CURSYM>`, when it overrides
 * the statement's `<CURDEF>`. `<ORIGCURRENCY>` is not read: it names the currency the bank converted
 * from, while the amount itself stays in `<CURDEF>`'s.
 */
function transactionCurrency(block: string): string | undefined {
  // `<CURRENCY>` is an aggregate, closed in both OFX versions; "<ORIGCURRENCY>" never matches "<CURRENCY>".
  const [currency] = findTagBlocks(block, "CURRENCY", { limit: 1 });
  return currency === undefined ? undefined : (extractTag(currency, "CURSYM") ?? "");
}

/**
 * Amounts are read in the minor units of `options.currency`, the account's (#671). A file whose
 * statement states another currency in `<CURDEF>`, or with a transaction stating another one in
 * `<CURRENCY><CURSYM>`, is refused whole, before any of its amounts is read (#672); the file's
 * `<CURRATE>` is never applied, since the account's register holds what the bank booked in its own
 * currency. A file with no `<CURDEF>` is read in the account's currency.
 *
 * A `<STMTTRN>` with no closing tag after it ends the file: it and anything after it are ignored.
 *
 * @throws ValidationError "currency_mismatch" (details: fileCurrency, accountCurrency) for a
 *   `<CURDEF>` or transaction `<CURSYM>` other than the account's currency;
 *   "invalid_ofx_transaction" for a `<STMTTRN>` missing DTPOSTED or TRNAMT; "invalid_date"/"invalid_amount_format"/"amount_too_large" for a
 *   malformed date or amount; "too_many_decimals" (details: decimals, currency) for an amount with a
 *   non-zero decimal beyond the account currency's (#671).
 */
export function parseOfx(content: string, options: ImportOptions): ImportRow[] {
  for (const currency of statedCurrencies(content)) assertFileCurrency(currency, options.currency);

  // A linear scan, not a lazy regular expression: see tag-blocks.ts (#675).
  const blocks = findTagBlocks(content, "STMTTRN");
  for (const block of blocks) assertFileCurrency(transactionCurrency(block), options.currency);

  return blocks.map((block) => {
    const dtposted = extractTag(block, "DTPOSTED");
    const trnamt = extractTag(block, "TRNAMT");
    if (!dtposted || !trnamt) {
      throw new ValidationError("invalid_ofx_transaction", "a <STMTTRN> is missing DTPOSTED or TRNAMT", {});
    }

    const date = parseOfxDate(dtposted);
    const amountCents = parseOfxAmount(trnamt, options.currency);
    const payee = extractTag(block, "NAME") ?? extractTag(block, "PAYEE") ?? "";
    const memo = extractTag(block, "MEMO");
    const externalId = extractTag(block, "FITID");

    return { date, payee, ...(memo ? { memo } : {}), amountCents, ...(externalId ? { externalId } : {}) };
  });
}
