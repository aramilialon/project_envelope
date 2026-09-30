/**
 * QIF import (design.md, "Import and reconciliation"): self-describing field
 * tags (D date, P payee, M memo, T amount, ^ end of transaction), so no
 * column mapping — but unlike OFX, QIF's date order (day first or month
 * first) and decimal separator are not standardized across sources: real
 * exports vary by the bank's own locale. Both are guessed from the file's
 * own data first (a date with a day or month past 12 settles the order; an
 * amount with a clean two-digit tail settles the separator); only when the
 * file gives no such evidence does parsing ask for an explicit hint instead
 * of silently choosing.
 *
 * Splits, categories, and check/cleared status are not read yet: this
 * covers plain transactions, the same normalized shape the CSV and OFX
 * importers produce (#28, #29), before duplicate detection.
 *
 * Pure, no file I/O: the caller reads the upload and passes its text content here.
 */

import { ValidationError } from "../errors.ts";
import { assertCents, type Cents } from "../money.ts";
import { assertDate, type LocalDate } from "../month.ts";
import type { ImportRow } from "./row.ts";

export type QifDateFormat = "DD/MM/YYYY" | "MM/DD/YYYY";
export type QifDecimalSeparator = "." | ",";

export interface QifHints {
  readonly dateFormat?: QifDateFormat;
  readonly decimalSeparator?: QifDecimalSeparator;
}

interface QifBlock {
  date?: string;
  payee?: string;
  memo?: string;
  amount?: string;
}

/** Splits the file into per-transaction blocks by its "^" end-of-record marker; unrecognized tags (N, L, C, A, S, E, ...) are ignored. */
function splitBlocks(content: string): QifBlock[] {
  const blocks: QifBlock[] = [];
  let current: QifBlock = {};

  for (const line of content.split(/\r\n|\r|\n/)) {
    if (line.length === 0) continue;
    const code = line[0];
    const value = line.slice(1);
    if (code === "^") {
      blocks.push(current);
      current = {};
    } else if (code === "D") {
      current.date = value;
    } else if (code === "P") {
      current.payee = value;
    } else if (code === "M") {
      current.memo = value;
    } else if (code === "T") {
      current.amount = value;
    }
  }

  return blocks;
}

const DATE_PATTERN = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/;

function detectDateFormat(dates: readonly string[], hint: QifDateFormat | undefined): QifDateFormat {
  if (hint) return hint;

  let dayFirst = false;
  let monthFirst = false;
  for (const raw of dates) {
    const match = DATE_PATTERN.exec(raw.trim());
    if (!match) continue;
    const [, first, second] = match as unknown as [string, string, string, string];
    if (Number(first) > 12) dayFirst = true;
    if (Number(second) > 12) monthFirst = true;
  }

  if (dayFirst && !monthFirst) return "DD/MM/YYYY";
  if (monthFirst && !dayFirst) return "MM/DD/YYYY";
  throw new ValidationError(
    "ambiguous_date_format",
    "every QIF date could be read either as DD/MM/YYYY or MM/DD/YYYY; specify dateFormat",
    {},
  );
}

function parseQifDate(text: string, format: QifDateFormat): LocalDate {
  const match = DATE_PATTERN.exec(text.trim());
  if (!match) {
    throw new ValidationError("invalid_date", `not a valid QIF date: "${text}"`, { value: text });
  }
  const [, first, second, yearRaw] = match as unknown as [string, string, string, string];
  const [day, month] = format === "DD/MM/YYYY" ? [first, second] : [second, first];
  const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  assertDate(date);
  return date;
}

function detectDecimalSeparator(amounts: readonly string[], hint: QifDecimalSeparator | undefined): QifDecimalSeparator {
  if (hint) return hint;

  for (const raw of amounts) {
    const trimmed = raw.trim();
    if (/^-?\d+,\d{1,2}$/.test(trimmed)) return ",";
    if (/^-?\d+\.\d{1,2}$/.test(trimmed)) return ".";
  }
  throw new ValidationError(
    "ambiguous_decimal_separator",
    'no QIF amount clearly settles "." or "," as the decimal separator; specify decimalSeparator',
    {},
  );
}

function parseQifAmount(text: string, decimalSeparator: QifDecimalSeparator): Cents {
  const trimmed = text.trim();
  const groupSeparator = decimalSeparator === "." ? "," : ".";
  const withoutGroups = trimmed.split(groupSeparator).join("");
  const normalized = decimalSeparator === "," ? withoutGroups.replace(",", ".") : withoutGroups;
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new ValidationError("invalid_amount_format", `not a valid QIF amount: "${text}"`, { text });
  }
  const cents = Math.round(Number(normalized) * 100);
  assertCents(cents);
  return cents;
}

/**
 * @throws ValidationError "ambiguous_date_format"/"ambiguous_decimal_separator" when the file's own data
 * gives no evidence and no hint was given; "invalid_qif_transaction" for a block missing D or T;
 * "invalid_date"/"invalid_amount_format" for a malformed one.
 */
export function parseQif(content: string, hints: QifHints = {}): ImportRow[] {
  const blocks = splitBlocks(content);
  if (blocks.length === 0) {
    return [];
  }

  const dateFormat = detectDateFormat(
    blocks.map((b) => b.date).filter((d): d is string => d !== undefined),
    hints.dateFormat,
  );
  const decimalSeparator = detectDecimalSeparator(
    blocks.map((b) => b.amount).filter((a): a is string => a !== undefined),
    hints.decimalSeparator,
  );

  return blocks.map((block) => {
    if (block.date === undefined || block.amount === undefined) {
      throw new ValidationError("invalid_qif_transaction", "a QIF transaction is missing D or T", {});
    }
    const date = parseQifDate(block.date, dateFormat);
    const amountCents = parseQifAmount(block.amount, decimalSeparator);
    const payee = block.payee ?? "";
    return { date, payee, ...(block.memo ? { memo: block.memo } : {}), amountCents };
  });
}
