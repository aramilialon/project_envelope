import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeDaysOfBuffer, type BufferAccount, type CashMovement } from "./days-of-buffer.ts";

const CHECKING: BufferAccount = { id: "checking", onBudget: true };
const WALLET: BufferAccount = { id: "wallet", onBudget: true };
const BROKER: BufferAccount = { id: "broker", onBudget: false };

describe("computeDaysOfBuffer", () => {
  it("weights the age of each euro spent by how much of it was spent, first in first out", () => {
    const movements: CashMovement[] = [
      { accountId: "checking", date: "2026-08-01", amount: 10_000 }, // one inflow
      { accountId: "checking", date: "2026-08-05", amount: -4_000 }, // 4 days old
      { accountId: "checking", date: "2026-08-10", amount: -6_000 }, // 9 days old
    ];
    const result = computeDaysOfBuffer([CHECKING], movements, "2026-08-10");
    assert.equal(result, (4 * 4_000 + 9 * 6_000) / 10_000); // 7.0
  });

  it("excludes a transfer between two on-budget accounts entirely", () => {
    const withoutTransfer: CashMovement[] = [
      { accountId: "checking", date: "2026-08-01", amount: 10_000 },
      { accountId: "checking", date: "2026-08-05", amount: -4_000 },
    ];
    const withTransfer: CashMovement[] = [
      ...withoutTransfer,
      { accountId: "checking", date: "2026-08-03", amount: -2_000, transferAccountId: "wallet" },
      { accountId: "wallet", date: "2026-08-03", amount: 2_000, transferAccountId: "checking" },
    ];
    const before = computeDaysOfBuffer([CHECKING, WALLET], withoutTransfer, "2026-08-05");
    const after = computeDaysOfBuffer([CHECKING, WALLET], withTransfer, "2026-08-05");
    assert.equal(before, after);
  });

  it("counts a transfer to an off-budget account as a real outflow", () => {
    const movements: CashMovement[] = [
      { accountId: "checking", date: "2026-08-01", amount: 10_000 },
      { accountId: "checking", date: "2026-08-06", amount: -3_000, transferAccountId: "broker" },
      { accountId: "broker", date: "2026-08-06", amount: 3_000, transferAccountId: "checking" },
    ];
    const result = computeDaysOfBuffer([CHECKING, BROKER], movements, "2026-08-06");
    assert.equal(result, 5); // the whole €30 is 5 days old, and broker itself is off-budget so ignored
  });

  it("ignores an outflow whose own date is more than 30 days before asOf", () => {
    const movements: CashMovement[] = [
      { accountId: "checking", date: "2026-06-01", amount: 10_000 },
      { accountId: "checking", date: "2026-06-05", amount: -1_000 }, // 92 days before asOf: outside the window
      { accountId: "checking", date: "2026-09-01", amount: -2_000 }, // 4 days before asOf: inside the window
    ];
    const result = computeDaysOfBuffer([CHECKING], movements, "2026-09-05");
    // Only the September outflow counts; the euros it spends are still the ones from June 1st (92 days old).
    assert.equal(result, 92);
  });

  it("treats spending with no prior inflow as instant, not negative or NaN", () => {
    const movements: CashMovement[] = [{ accountId: "checking", date: "2026-08-01", amount: -5_000 }];
    const result = computeDaysOfBuffer([CHECKING], movements, "2026-08-01");
    assert.equal(result, 0);
  });

  it("returns 0 when there is no outflow at all in the last 30 days", () => {
    const movements: CashMovement[] = [{ accountId: "checking", date: "2026-08-01", amount: 10_000 }];
    const result = computeDaysOfBuffer([CHECKING], movements, "2026-08-01");
    assert.equal(result, 0);
  });

  it("ignores movements of an unknown or off-budget account entirely", () => {
    const movements: CashMovement[] = [
      { accountId: "broker", date: "2026-08-01", amount: 10_000 },
      { accountId: "broker", date: "2026-08-05", amount: -4_000 },
    ];
    const result = computeDaysOfBuffer([CHECKING, BROKER], movements, "2026-08-05");
    assert.equal(result, 0);
  });

  it("invariant: never negative, never NaN, over 200 random histories", () => {
    const random = randomGenerator(11);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const amount = (max: number) => Math.floor(random() * max) + 1;
    const day = () => `2026-${String(pick([6, 7, 8, 9])).padStart(2, "0")}-${String(amount(28)).padStart(2, "0")}`;
    const accounts: BufferAccount[] = [
      { id: "checking", onBudget: true },
      { id: "wallet", onBudget: true },
      { id: "broker", onBudget: false },
    ];

    for (let run = 0; run < 200; run++) {
      const movements: CashMovement[] = [];
      for (let i = 0; i < 25; i++) {
        const sign = pick([1, 1, -1, -1, -1]);
        const account = pick(["checking", "wallet", "broker"]);
        if (Math.floor(random() * 4) === 0) {
          const other = pick(["checking", "wallet", "broker"].filter((a) => a !== account));
          movements.push({ accountId: account, date: day(), amount: sign * amount(50_000), transferAccountId: other });
        } else {
          movements.push({ accountId: account, date: day(), amount: sign * amount(50_000) });
        }
      }
      const result = computeDaysOfBuffer(accounts, movements, "2026-09-28");
      assert.ok(Number.isFinite(result), `run ${run}: not finite (${result})`);
      assert.ok(result >= 0, `run ${run}: negative (${result})`);
    }
  });
});

/** Pseudo-random numbers with a fixed seed (mulberry32), so failures are reproducible. */
function randomGenerator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
