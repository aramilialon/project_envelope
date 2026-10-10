/**
 * CSV import (design.md, "Import and reconciliation"): a CSV file needs a
 * column mapping — date, description, either one amount column or separate
 * outflow and inflow columns, plus an optional memo; the date format, the
 * decimal separator, and whether the first row holds column names. OFX, QIF
 * and CAMT.053 are self-describing and need no mapping.
 *
 * Pure, no file I/O: the caller reads the upload and passes its text content
 * here; nothing here stores the file itself.
 */

import { ValidationError } from "../errors.ts";
import type { Cents } from "../money.ts";
import { assertCents } from "../money.ts";
import { assertDate, type LocalDate } from "../month.ts";
import type { ImportRow } from "./row.ts";

export type CsvDateFormat = "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
export type DecimalSeparator = "." | ",";

interface AmountColumnMapping {
  readonly amountColumn: number;
}
interface SplitColumnMapping {
  readonly outflowColumn: number;
  readonly inflowColumn: number;
}

export type CsvMapping = (AmountColumnMapping | SplitColumnMapping) & {
  readonly hasHeaderRow: boolean;
  readonly dateColumn: number;
  readonly dateFormat: CsvDateFormat;
  readonly descriptionColumn: number;
  readonly decimalSeparator: DecimalSeparator;
  readonly memoColumn?: number;
};

/** CSV never carries a bank transaction id: `externalId` is always absent (see `ImportRow`). */
export type CsvRow = ImportRow;

/**
 * One CSV line's fields, honoring double-quoted fields (with embedded commas, and "" as an
 * escaped quote). Exported (not just `parseCsv`'s own internal) so the web app's own column
 * mapping step (#59) can split the same file into a preview grid before a mapping even exists
 * yet — the one piece of CSV parsing that happens before the user has picked which column is
 * which, so it cannot go through `parseCsv` itself.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function parseCsvDate(text: string, format: CsvDateFormat): LocalDate {
  const trimmed = text.trim();
  let date: LocalDate;
  if (format === "YYYY-MM-DD") {
    date = trimmed;
  } else {
    const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
    if (!match) {
      throw new ValidationError("invalid_date", `not a valid ${format} date: "${text}"`, { value: text });
    }
    const [, first, second, year] = match as unknown as [string, string, string, string];
    const [month, day] = format === "DD/MM/YYYY" ? [second, first] : [first, second];
    date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  assertDate(date);
  return date;
}

function parseCsvAmount(text: string, decimalSeparator: DecimalSeparator): Cents {
  const trimmed = text.trim();
  const groupSeparator = decimalSeparator === "." ? "," : ".";
  const withoutGroups = trimmed.split(groupSeparator).join("");
  const normalized = decimalSeparator === "," ? withoutGroups.replace(",", ".") : withoutGroups;
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new ValidationError("invalid_amount_format", `not a valid amount: "${text}"`, { text });
  }
  const cents = Math.round(Number(normalized) * 100);
  assertCents(cents);
  return cents;
}

function field(columns: readonly string[], index: number): string {
  return columns[index]?.trim() ?? "";
}

/**
 * @throws ValidationError for a malformed date, amount, or a row with too few columns.
 */
export function parseCsv(content: string, mapping: CsvMapping): CsvRow[] {
  const lines = content.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
  const dataLines = mapping.hasHeaderRow ? lines.slice(1) : lines;

  return dataLines.map((line) => {
    const columns = splitCsvLine(line);
    const date = parseCsvDate(field(columns, mapping.dateColumn), mapping.dateFormat);
    const payee = field(columns, mapping.descriptionColumn);
    const memo = mapping.memoColumn !== undefined ? field(columns, mapping.memoColumn) : "";

    let amountCents: Cents;
    if ("amountColumn" in mapping) {
      amountCents = parseCsvAmount(field(columns, mapping.amountColumn), mapping.decimalSeparator);
    } else {
      const outflowText = field(columns, mapping.outflowColumn);
      const inflowText = field(columns, mapping.inflowColumn);
      if (inflowText) {
        amountCents = parseCsvAmount(inflowText, mapping.decimalSeparator);
      } else if (outflowText) {
        amountCents = -Math.abs(parseCsvAmount(outflowText, mapping.decimalSeparator));
      } else {
        amountCents = 0;
      }
    }

    return { date, payee, ...(memo ? { memo } : {}), amountCents };
  });
}
