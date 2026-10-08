import { describe, expect, it } from "vitest";

import type { CandidateTransaction } from "./api.ts";
import { computeTally, findSuggestion } from "./reconciliationTally.ts";

function tx(id: string, occurredAt: string, amountCents: number): CandidateTransaction {
  return { id, occurredAt, payee: `payee-${id}`, amountCents };
}

describe("computeTally", () => {
  it("adds the last reconciled balance to the ticked (not off) cleared transactions", () => {
    const cleared = [tx("a", "2026-09-10", -1000), tx("b", "2026-09-12", 2500)];
    const tally = computeTally(50000, cleared, new Set(), 51500);
    expect(tally.clearedBalanceCents).toBe(51500);
    expect(tally.differenceCents).toBe(0);
  });

  it("excludes a transaction the user has unticked", () => {
    const cleared = [tx("a", "2026-09-10", -1000), tx("b", "2026-09-12", 2500)];
    const tally = computeTally(50000, cleared, new Set(["b"]), 49000);
    expect(tally.clearedBalanceCents).toBe(49000);
    expect(tally.differenceCents).toBe(0);
  });

  it("has no difference while the statement balance has not been typed yet", () => {
    const tally = computeTally(50000, [], new Set(), null);
    expect(tally.differenceCents).toBeNull();
  });
});

describe("findSuggestion", () => {
  it("finds no suggestion when the difference is zero or unknown", () => {
    const pending = [tx("p", "2026-09-20", 500)];
    expect(findSuggestion(pending, [], 0, "2026-09-26")).toBeUndefined();
    expect(findSuggestion(pending, [], null, "2026-09-26")).toBeUndefined();
  });

  it("suggests a pending transaction whose own amount equals the difference", () => {
    const pending = [tx("p", "2026-09-20", 500)];
    const suggestion = findSuggestion(pending, [], 500, "2026-09-26");
    expect(suggestion).toEqual({ transaction: pending[0], kind: "pending" });
  });

  it("suggests an unticked cleared transaction whose own amount equals the difference", () => {
    const unticked = [tx("u", "2026-09-22", -300)];
    const suggestion = findSuggestion([], unticked, -300, "2026-09-26");
    expect(suggestion).toEqual({ transaction: unticked[0], kind: "unticked" });
  });

  it("breaks a tie between two equal-amount candidates by picking the one closest to the statement date", () => {
    const pending = [tx("far", "2026-09-01", 500), tx("near", "2026-09-25", 500)];
    const suggestion = findSuggestion(pending, [], 500, "2026-09-26");
    expect(suggestion?.transaction.id).toBe("near");
  });
});
