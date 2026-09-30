/**
 * A row is a duplicate of a transaction already in the same account (design.md,
 * "Import and reconciliation") when the bank's own transaction id matches
 * (formats that carry one, such as OFX), or otherwise when the amount is the
 * same and the dates are at most 3 days apart. Each existing transaction
 * matches at most one incoming row.
 *
 * Pure, no database: the caller loads the account's existing transactions and
 * gives them here alongside the rows an import produced.
 */

import { daysBetween } from "../month.ts";
import type { Cents } from "../money.ts";
import type { LocalDate } from "../month.ts";

const DATE_WINDOW_DAYS = 3;

export interface ImportedTransaction {
  /** The bank's own transaction id, when the format carries one (e.g. OFX's FITID). */
  readonly externalId?: string;
  readonly date: LocalDate;
  readonly amount: Cents;
}

export interface ExistingTransaction {
  readonly id: string;
  readonly externalId?: string;
  readonly date: LocalDate;
  readonly amount: Cents;
}

export interface DuplicateMatch {
  /** Index into the `incoming` array this match is for. */
  readonly incomingIndex: number;
  readonly existingId: string;
}

/**
 * Matches each incoming row against at most one existing transaction, in
 * `incoming` order: an already-claimed existing transaction is never matched
 * again, even if a later row would otherwise fit it too.
 */
export function detectDuplicates(
  incoming: readonly ImportedTransaction[],
  existing: readonly ExistingTransaction[],
): DuplicateMatch[] {
  const claimed = new Set<string>();
  const matches: DuplicateMatch[] = [];

  incoming.forEach((row, incomingIndex) => {
    const match = matchByExternalId(row, existing, claimed) ?? matchByAmountAndDate(row, existing, claimed);
    if (match) {
      claimed.add(match.id);
      matches.push({ incomingIndex, existingId: match.id });
    }
  });

  return matches;
}

function matchByExternalId(
  row: ImportedTransaction,
  existing: readonly ExistingTransaction[],
  claimed: ReadonlySet<string>,
): ExistingTransaction | undefined {
  if (row.externalId === undefined) {
    return undefined;
  }
  return existing.find((e) => !claimed.has(e.id) && e.externalId === row.externalId);
}

function matchByAmountAndDate(
  row: ImportedTransaction,
  existing: readonly ExistingTransaction[],
  claimed: ReadonlySet<string>,
): ExistingTransaction | undefined {
  let best: { candidate: ExistingTransaction; distance: number } | undefined;
  for (const candidate of existing) {
    if (claimed.has(candidate.id) || candidate.amount !== row.amount) {
      continue;
    }
    const distance = Math.abs(daysBetween(candidate.date, row.date));
    if (distance > DATE_WINDOW_DAYS) {
      continue;
    }
    if (best === undefined || distance < best.distance) {
      best = { candidate, distance };
    }
  }
  return best?.candidate;
}
