import { splitCsvLine } from "@envelope/core";

import type { CsvDateFormat, CsvMapping, DecimalSeparator } from "./api.ts";

/** A CSV column's assigned meaning (`docs/ux/mockups/import-reconciliation.html`'s own "Colonne" step), "" for a column the import ignores. */
export type ColumnRole = "" | "date" | "desc" | "amount" | "out" | "in" | "memo";

/** Splits a CSV file's own lines into a preview grid — the same `splitCsvLine` `@envelope/core` uses for the real import, so the preview can never disagree with what staging actually does. Filters out blank lines, matching `parseCsv`'s own behavior. */
export function splitCsvPreview(content: string): string[][] {
  return content
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== "")
    .map(splitCsvLine);
}

/**
 * Guesses each column's role from a header row's own text (`docs/ux/mockups/import-reconciliation.html`'s
 * own regexes, translated to English column names a real bank export is at least as likely to
 * use) — a convenience the user can always override, never load-bearing.
 */
export function guessColumnRoles(headerRow: readonly string[]): ColumnRole[] {
  const used = new Set<ColumnRole>();
  return headerRow.map((header): ColumnRole => {
    const h = header.toLowerCase();
    let role: ColumnRole = "";
    if (/^date$|booking|posted/.test(h)) role = "date";
    else if (/descr|payee|detail|memo|narrative/.test(h)) role = "desc";
    else if (/^amount$/.test(h)) role = "amount";
    else if (/debit|outflow|withdrawal/.test(h)) role = "out";
    else if (/credit|inflow|deposit/.test(h)) role = "in";
    if (role && used.has(role)) {
      role = "";
    }
    if (role) {
      used.add(role);
    }
    return role;
  });
}

export type MappingProblem = "missing_date" | "missing_description" | "missing_amount";

/** What's still wrong with a set of column roles before they can become a real `CsvMapping` — design.md's own three required pieces (date, description, an amount column or a matching outflow/inflow pair). */
export function mappingProblems(roles: readonly ColumnRole[]): MappingProblem[] {
  const problems: MappingProblem[] = [];
  if (!roles.includes("date")) {
    problems.push("missing_date");
  }
  if (!roles.includes("desc")) {
    problems.push("missing_description");
  }
  if (!roles.includes("amount") && !(roles.includes("out") && roles.includes("in"))) {
    problems.push("missing_amount");
  }
  return problems;
}

/** The inverse of `buildCsvMapping`: a saved (or just-built) mapping's own column roles, to prefill the picker when revisiting an account with one already remembered. */
export function rolesFromMapping(mapping: CsvMapping, columnCount: number): ColumnRole[] {
  const roles: ColumnRole[] = new Array(columnCount).fill("");
  const assign = (index: number, role: ColumnRole) => {
    if (index >= 0 && index < columnCount) {
      roles[index] = role;
    }
  };
  assign(mapping.dateColumn, "date");
  assign(mapping.descriptionColumn, "desc");
  if (mapping.memoColumn !== undefined) {
    assign(mapping.memoColumn, "memo");
  }
  if ("amountColumn" in mapping) {
    assign(mapping.amountColumn, "amount");
  } else {
    assign(mapping.outflowColumn, "out");
    assign(mapping.inflowColumn, "in");
  }
  return roles;
}

export interface BuildMappingOptions {
  readonly hasHeaderRow: boolean;
  readonly dateFormat: CsvDateFormat;
  readonly decimalSeparator: DecimalSeparator;
}

/** `undefined` when `mappingProblems` would be non-empty — the caller checks that first and never calls this otherwise, but the return type still says so rather than throwing. */
export function buildCsvMapping(roles: readonly ColumnRole[], options: BuildMappingOptions): CsvMapping | undefined {
  if (mappingProblems(roles).length > 0) {
    return undefined;
  }
  const dateColumn = roles.indexOf("date");
  const descriptionColumn = roles.indexOf("desc");
  const memoColumn = roles.indexOf("memo");
  const shared = {
    hasHeaderRow: options.hasHeaderRow,
    dateColumn,
    dateFormat: options.dateFormat,
    descriptionColumn,
    decimalSeparator: options.decimalSeparator,
    ...(memoColumn >= 0 ? { memoColumn } : {}),
  };
  const amountColumn = roles.indexOf("amount");
  if (amountColumn >= 0) {
    return { ...shared, amountColumn };
  }
  return { ...shared, outflowColumn: roles.indexOf("out"), inflowColumn: roles.indexOf("in") };
}
