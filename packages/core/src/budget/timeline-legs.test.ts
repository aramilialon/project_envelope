import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countsOnWorkspaceTimeline, isStartingBalanceSplit, type TimelineLeg } from "./timeline-legs.ts";
import { mulberry32 } from "../testing/random.ts";

const plain = { transferPartnerOnBudget: null, startingBalance: false } as const;

/** A leg with its amount, for the running totals below. */
interface Movement {
  readonly leg: TimelineLeg;
  readonly amountCents: number;
}

/** The running total after each movement, every movement included (a leg that does not count leaves it where it was). */
function runningTotals(movements: readonly Movement[]): number[] {
  let total = 0;
  return movements.map((m) => {
    if (countsOnWorkspaceTimeline(m.leg)) {
      total += m.amountCents;
    }
    return total;
  });
}

describe("isStartingBalanceSplit", () => {
  it("is the one split of a non-transfer categorized to the card's own payment category", () => {
    assert.equal(isStartingBalanceSplit({ transferId: null, splitCount: 1, categoryId: "pay-visa", paymentCategoryId: "pay-visa" }), true);
  });

  it("is not a card purchase, a card payment, a split or a cash account's own income", () => {
    assert.equal(isStartingBalanceSplit({ transferId: null, splitCount: 1, categoryId: "groceries", paymentCategoryId: "pay-visa" }), false);
    assert.equal(isStartingBalanceSplit({ transferId: "t1", splitCount: 1, categoryId: null, paymentCategoryId: "pay-visa" }), false);
    assert.equal(isStartingBalanceSplit({ transferId: "t1", splitCount: 1, categoryId: "pay-visa", paymentCategoryId: "pay-visa" }), false);
    assert.equal(isStartingBalanceSplit({ transferId: null, splitCount: 2, categoryId: "pay-visa", paymentCategoryId: "pay-visa" }), false);
    assert.equal(isStartingBalanceSplit({ transferId: null, splitCount: 1, categoryId: null, paymentCategoryId: null }), false);
  });
});

describe("countsOnWorkspaceTimeline", () => {
  it("counts an on-budget leg that is not a transfer: income, a cash purchase, a card purchase", () => {
    assert.equal(countsOnWorkspaceTimeline({ onBudget: true, ...plain }), true);
  });

  it("never counts a leg on an off-budget account", () => {
    assert.equal(countsOnWorkspaceTimeline({ onBudget: false, ...plain }), false);
    assert.equal(countsOnWorkspaceTimeline({ onBudget: false, transferPartnerOnBudget: true, startingBalance: false }), false);
    assert.equal(countsOnWorkspaceTimeline({ onBudget: false, transferPartnerOnBudget: false, startingBalance: false }), false);
  });

  it("counts neither leg of a transfer between two on-budget accounts, a card payment included", () => {
    assert.equal(countsOnWorkspaceTimeline({ onBudget: true, transferPartnerOnBudget: true, startingBalance: false }), false);
  });

  it("counts the on-budget leg of a transfer with an off-budget account", () => {
    assert.equal(countsOnWorkspaceTimeline({ onBudget: true, transferPartnerOnBudget: false, startingBalance: false }), true);
  });

  it("does not count a card's starting balance", () => {
    assert.equal(countsOnWorkspaceTimeline({ onBudget: true, transferPartnerOnBudget: null, startingBalance: true }), false);
  });

  it("Checking -> Visa: income 3,000.00, a 41.00 card purchase, the card paid from checking: 3,000.00, 2,959.00, 2,959.00", () => {
    const movements: Movement[] = [
      { leg: { onBudget: true, ...plain }, amountCents: 300_000 }, // income into checking
      { leg: { onBudget: true, ...plain }, amountCents: -4_100 }, // purchase on the Visa card
      { leg: { onBudget: true, transferPartnerOnBudget: true, startingBalance: false }, amountCents: -4_100 }, // payment, checking leg
      { leg: { onBudget: true, transferPartnerOnBudget: true, startingBalance: false }, amountCents: 4_100 }, // payment, Visa leg
    ];
    assert.deepEqual(runningTotals(movements), [300_000, 295_900, 295_900, 295_900]);
  });

  it("Checking -> Savings, both on budget: no movement at all", () => {
    const movements: Movement[] = [
      { leg: { onBudget: true, transferPartnerOnBudget: true, startingBalance: false }, amountCents: -50_000 },
      { leg: { onBudget: true, transferPartnerOnBudget: true, startingBalance: false }, amountCents: 50_000 },
    ];
    assert.deepEqual(runningTotals(movements), [0, 0]);
  });

  it("Checking <-> broker: each transfer counts once, at the checking end", () => {
    const movements: Movement[] = [
      { leg: { onBudget: true, transferPartnerOnBudget: false, startingBalance: false }, amountCents: -60_000 }, // checking -> broker, checking leg
      { leg: { onBudget: false, transferPartnerOnBudget: true, startingBalance: false }, amountCents: 60_000 }, // broker leg
      { leg: { onBudget: false, transferPartnerOnBudget: true, startingBalance: false }, amountCents: -25_000 }, // broker -> checking, broker leg
      { leg: { onBudget: true, transferPartnerOnBudget: false, startingBalance: false }, amountCents: 25_000 }, // checking leg
    ];
    assert.deepEqual(runningTotals(movements), [-60_000, -60_000, -60_000, -35_000]);
  });

  it("Visa -> Mastercard: moving debt between two cards is no movement", () => {
    const movements: Movement[] = [
      { leg: { onBudget: true, transferPartnerOnBudget: true, startingBalance: false }, amountCents: -12_345 },
      { leg: { onBudget: true, transferPartnerOnBudget: true, startingBalance: false }, amountCents: 12_345 },
    ];
    assert.deepEqual(runningTotals(movements), [0, 0]);
  });
});

describe("countsOnWorkspaceTimeline, property", () => {
  type Kind = "cash" | "card";
  interface Account {
    readonly id: string;
    readonly kind: Kind;
    readonly onBudget: boolean;
    readonly paymentCategoryId: string | null;
  }
  interface Split {
    readonly accountId: string;
    readonly transferId: string | null;
    readonly partnerAccountId: string | null;
    readonly splitCount: number;
    readonly categoryId: string | null;
    readonly amountCents: number;
  }

  it("the legs that count add up to the change in on-budget cash less the change in card debt, card starting balances left out", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = mulberry32(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
      const amount = (): number => Math.floor(random() * 200_000) + 1;

      const accounts: Account[] = [];
      const count = 2 + Math.floor(random() * 5);
      for (let i = 0; i < count; i++) {
        const kind: Kind = random() < 0.4 ? "card" : "cash";
        accounts.push({ id: `a${i}`, kind, onBudget: random() < 0.7, paymentCategoryId: kind === "card" ? `pay-a${i}` : null });
      }
      const byId = new Map(accounts.map((a) => [a.id, a]));

      const splits: Split[] = [];
      for (const card of accounts.filter((a) => a.kind === "card")) {
        if (random() < 0.6) {
          splits.push({ accountId: card.id, transferId: null, partnerAccountId: null, splitCount: 1, categoryId: card.paymentCategoryId, amountCents: -amount() });
        }
      }
      const operations = Math.floor(random() * 25);
      for (let i = 0; i < operations; i++) {
        const roll = random();
        if (roll < 0.5) {
          // An ordinary transaction, one to three splits (signed either way: spending, income, a refund).
          const account = pick(accounts);
          const splitCount = 1 + Math.floor(random() * 3);
          for (let s = 0; s < splitCount; s++) {
            const sign = random() < 0.75 ? -1 : 1;
            splits.push({ accountId: account.id, transferId: null, partnerAccountId: null, splitCount, categoryId: `cat${s}`, amountCents: sign * amount() });
          }
        } else {
          // A transfer between two different accounts: a card payment, card-to-card, cash-to-cash, to or from off-budget.
          const source = pick(accounts);
          const destination = pick(accounts.filter((a) => a.id !== source.id));
          const cents = amount();
          splits.push({ accountId: source.id, transferId: `t${i}`, partnerAccountId: destination.id, splitCount: 1, categoryId: null, amountCents: -cents });
          splits.push({ accountId: destination.id, transferId: `t${i}`, partnerAccountId: source.id, splitCount: 1, categoryId: null, amountCents: cents });
        }
      }

      let counted = 0;
      let cashChange = 0;
      let cardDebtChange = 0;
      for (const split of splits) {
        const account = byId.get(split.accountId)!;
        const startingBalance = isStartingBalanceSplit({
          transferId: split.transferId,
          splitCount: split.splitCount,
          categoryId: split.categoryId,
          paymentCategoryId: account.paymentCategoryId,
        });
        const leg: TimelineLeg = {
          onBudget: account.onBudget,
          transferPartnerOnBudget: split.partnerAccountId === null ? null : byId.get(split.partnerAccountId)!.onBudget,
          startingBalance,
        };
        if (countsOnWorkspaceTimeline(leg)) {
          counted += split.amountCents;
        }
        if (!account.onBudget || startingBalance) {
          continue;
        }
        if (account.kind === "cash") {
          cashChange += split.amountCents;
        } else {
          cardDebtChange -= split.amountCents; // a card's balance is negative when it owes: spending lowers it, raising the debt
        }
      }
      assert.equal(counted, cashChange - cardDebtChange, `seed ${seed}`);
    }
  });
});
