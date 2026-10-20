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
  const byExternalId = groupByExternalId(existing);
  const byAmount = groupByAmount(existing);

  incoming.forEach((row, incomingIndex) => {
    const match = matchByExternalId(row, byExternalId, claimed) ?? matchByAmountAndDate(row, byAmount, claimed);
    if (match) {
      claimed.add(match.id);
      matches.push({ incomingIndex, existingId: match.id });
    }
  });

  return matches;
}

/** Groups by the field each matcher narrows on first, so each incoming row only scans its own bucket. */
function groupByExternalId(existing: readonly ExistingTransaction[]): Map<string, ExistingTransaction[]> {
  const map = new Map<string, ExistingTransaction[]>();
  for (const candidate of existing) {
    if (candidate.externalId === undefined) continue;
    const bucket = map.get(candidate.externalId);
    if (bucket) bucket.push(candidate);
    else map.set(candidate.externalId, [candidate]);
  }
  return map;
}

function groupByAmount(existing: readonly ExistingTransaction[]): Map<Cents, ExistingTransaction[]> {
  const map = new Map<Cents, ExistingTransaction[]>();
  for (const candidate of existing) {
    const bucket = map.get(candidate.amount);
    if (bucket) bucket.push(candidate);
    else map.set(candidate.amount, [candidate]);
  }
  return map;
}

function matchByExternalId(
  row: ImportedTransaction,
  byExternalId: ReadonlyMap<string, readonly ExistingTransaction[]>,
  claimed: ReadonlySet<string>,
): ExistingTransaction | undefined {
  if (row.externalId === undefined) {
    return undefined;
  }
  return byExternalId.get(row.externalId)?.find((e) => !claimed.has(e.id));
}

function matchByAmountAndDate(
  row: ImportedTransaction,
  byAmount: ReadonlyMap<Cents, readonly ExistingTransaction[]>,
  claimed: ReadonlySet<string>,
): ExistingTransaction | undefined {
  let best: { candidate: ExistingTransaction; distance: number } | undefined;
  for (const candidate of byAmount.get(row.amount) ?? []) {
    if (claimed.has(candidate.id)) {
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
