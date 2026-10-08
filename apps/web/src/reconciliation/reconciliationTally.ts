import type { CandidateTransaction } from "./api.ts";

/**
 * The reconciliation screen's own running tally (design.md, "Import and reconciliation"): the
 * cleared balance is the last reconciliation's own statement balance plus the cleared
 * transactions the user keeps ticked, and the difference against the statement balance the user
 * typed. Kept client-side, recomputed on every keystroke or checkbox, so ticking/unticking and
 * typing the statement balance feel instant — the authoritative check happens server-side, in
 * `reconcileAccount`, only when the user actually submits.
 */
export interface ReconciliationTally {
  readonly clearedBalanceCents: number;
  /** `null` until the user has typed a parseable statement balance. */
  readonly differenceCents: number | null;
}

export function computeTally(
  lastReconciledBalanceCents: number,
  clearedTransactions: readonly CandidateTransaction[],
  offIds: ReadonlySet<string>,
  statementBalanceCents: number | null,
): ReconciliationTally {
  const tickedTotalCents = clearedTransactions
    .filter((t) => !offIds.has(t.id))
    .reduce((sum, t) => sum + t.amountCents, 0);
  const clearedBalanceCents = lastReconciledBalanceCents + tickedTotalCents;
  return {
    clearedBalanceCents,
    differenceCents: statementBalanceCents === null ? null : statementBalanceCents - clearedBalanceCents,
  };
}

export interface ReconciliationSuggestion {
  readonly transaction: CandidateTransaction;
  readonly kind: "pending" | "unticked";
}

/**
 * A pending or unticked transaction whose own amount exactly equals the difference — the same
 * "clue" `apps/api`'s own `findSuggestion` offers once a reconciliation attempt comes back
 * non-zero, computed here too so the screen can show it immediately, before any submission.
 * Ties (more than one transaction of the same amount) break on whichever is closest in time to
 * the statement date, matching the server's own choice.
 */
export function findSuggestion(
  pendingTransactions: readonly CandidateTransaction[],
  unticked: readonly CandidateTransaction[],
  differenceCents: number | null,
  asOfDate: string,
): ReconciliationSuggestion | undefined {
  if (differenceCents === null || differenceCents === 0) {
    return undefined;
  }
  const candidates: ReconciliationSuggestion[] = [
    ...pendingTransactions.filter((t) => t.amountCents === differenceCents).map((transaction) => ({ transaction, kind: "pending" as const })),
    ...unticked.filter((t) => t.amountCents === differenceCents).map((transaction) => ({ transaction, kind: "unticked" as const })),
  ];
  if (candidates.length === 0) {
    return undefined;
  }
  const asOfMs = Date.parse(asOfDate);
  const distance = (t: CandidateTransaction): number => Math.abs(Date.parse(t.occurredAt) - asOfMs);
  return [...candidates].sort((a, b) => distance(a.transaction) - distance(b.transaction))[0];
}
