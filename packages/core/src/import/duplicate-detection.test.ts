import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectDuplicates, type ExistingTransaction, type ImportedTransaction } from "./duplicate-detection.ts";

describe("detectDuplicates", () => {
  it("matches by the bank's own transaction id", () => {
    const existing: ExistingTransaction[] = [
      { id: "e1", externalId: "FITID-1", date: "2026-09-01", amount: -5000 },
      { id: "e2", externalId: "FITID-2", date: "2026-09-05", amount: -3000 },
    ];
    const incoming: ImportedTransaction[] = [{ externalId: "FITID-2", date: "2026-09-05", amount: -3000 }];

    const matches = detectDuplicates(incoming, existing);
    assert.deepEqual(matches, [{ incomingIndex: 0, existingId: "e2" }]);
  });

  it("matches by amount and a date within 3 days when there is no external id", () => {
    const existing: ExistingTransaction[] = [{ id: "e1", date: "2026-09-01", amount: -4200 }];
    const incoming: ImportedTransaction[] = [{ date: "2026-09-04", amount: -4200 }]; // 3 days later

    const matches = detectDuplicates(incoming, existing);
    assert.deepEqual(matches, [{ incomingIndex: 0, existingId: "e1" }]);
  });

  it("does not match past the 3-day window", () => {
    const existing: ExistingTransaction[] = [{ id: "e1", date: "2026-09-01", amount: -4200 }];
    const incoming: ImportedTransaction[] = [{ date: "2026-09-05", amount: -4200 }]; // 4 days later

    assert.deepEqual(detectDuplicates(incoming, existing), []);
  });

  it("does not match a different amount, even on the same day", () => {
    const existing: ExistingTransaction[] = [{ id: "e1", date: "2026-09-01", amount: -4200 }];
    const incoming: ImportedTransaction[] = [{ date: "2026-09-01", amount: -4300 }];

    assert.deepEqual(detectDuplicates(incoming, existing), []);
  });

  it("each existing transaction matches at most one incoming row", () => {
    const existing: ExistingTransaction[] = [{ id: "e1", date: "2026-09-01", amount: -1000 }];
    const incoming: ImportedTransaction[] = [
      { date: "2026-09-01", amount: -1000 },
      { date: "2026-09-02", amount: -1000 },
    ];

    const matches = detectDuplicates(incoming, existing);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.incomingIndex, 0); // first row in order claims it
  });

  it("picks the closest date among several amount matches", () => {
    const existing: ExistingTransaction[] = [
      { id: "far", date: "2026-09-01", amount: -1000 },
      { id: "close", date: "2026-09-03", amount: -1000 },
    ];
    const incoming: ImportedTransaction[] = [{ date: "2026-09-04", amount: -1000 }];

    const matches = detectDuplicates(incoming, existing);
    assert.deepEqual(matches, [{ incomingIndex: 0, existingId: "close" }]);
  });

  it("falls back to amount and date when the external id does not match any existing row", () => {
    const existing: ExistingTransaction[] = [{ id: "e1", date: "2026-09-01", amount: -1000 }];
    const incoming: ImportedTransaction[] = [{ externalId: "unknown-fitid", date: "2026-09-01", amount: -1000 }];

    const matches = detectDuplicates(incoming, existing);
    assert.deepEqual(matches, [{ incomingIndex: 0, existingId: "e1" }]);
  });
});
