import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import type { BudgetInput } from "./budget-month.ts";
import { computeBudgetMonth } from "./budget-month.ts";
import type { BudgetAccount, BudgetTransaction } from "./transactions.ts";
import { aggregateTransactions, UNASSIGNED } from "./transactions.ts";

const ACCOUNTS: readonly BudgetAccount[] = [
  { id: "checking", type: "cash", onBudget: true },
  { id: "savings", type: "cash", onBudget: true },
  { id: "visa", type: "credit", onBudget: true, paymentCategoryId: "visa-payment" },
  { id: "broker", type: "cash", onBudget: false },
];

/** Builds a transaction with a generated id. */
let counter = 0;
function tx(fields: Omit<BudgetTransaction, "id">): BudgetTransaction {
  counter += 1;
  return { id: `t${counter}`, ...fields };
}

describe("aggregateTransactions", () => {
  it("turns unassigned inflows into income and categorized outflows into activity", () => {
    const result = aggregateTransactions(ACCOUNTS, [
      tx({ accountId: "checking", date: "2026-09-01", amount: 200000, categoryId: UNASSIGNED }),
      tx({ accountId: "checking", date: "2026-09-03", amount: -4550, categoryId: "groceries" }),
    ]);

    assert.deepEqual(result.income, [{ month: "2026-09", amount: 200000 }]);
    assert.deepEqual(result.activity, [{ categoryId: "groceries", month: "2026-09", amount: -4550 }]);
    assert.deepEqual(result.cardPayments, []);
  });

  it("tags credit card activity with the card's payment category", () => {
    const result = aggregateTransactions(ACCOUNTS, [
      tx({ accountId: "visa", date: "2026-09-05", amount: -3000, categoryId: "fun" }),
    ]);

    assert.deepEqual(result.activity, [
      { categoryId: "fun", month: "2026-09", amount: -3000, paymentCategoryId: "visa-payment" },
    ]);
  });

  it("spreads a split transaction across its categories", () => {
    const result = aggregateTransactions(ACCOUNTS, [
      tx({
        accountId: "checking",
        date: "2026-09-06",
        amount: -10000,
        splits: [
          { categoryId: "groceries", amount: -7000 },
          { categoryId: "home", amount: -3000 },
        ],
      }),
    ]);

    assert.deepEqual(
      result.activity.map((a) => [a.categoryId, a.amount]),
      [
        ["groceries", -7000],
        ["home", -3000],
      ],
    );
  });

  it("counts a card payment once, from the card side, and ignores transfers between cash accounts", () => {
    const result = aggregateTransactions(ACCOUNTS, [
      // Paying the card: two sides of one transfer
      tx({ accountId: "checking", date: "2026-09-20", amount: -25000, transferAccountId: "visa" }),
      tx({ accountId: "visa", date: "2026-09-20", amount: 25000, transferAccountId: "checking" }),
      // Moving money to savings
      tx({ accountId: "checking", date: "2026-09-21", amount: -50000, transferAccountId: "savings" }),
      tx({ accountId: "savings", date: "2026-09-21", amount: 50000, transferAccountId: "checking" }),
    ]);

    assert.deepEqual(result.cardPayments, [{ paymentCategoryId: "visa-payment", month: "2026-09", amount: 25000 }]);
    assert.deepEqual(result.activity, []);
    assert.deepEqual(result.income, []);
  });

  it("treats a transfer to an off-budget account as categorized activity, and ignores off-budget accounts", () => {
    const result = aggregateTransactions(ACCOUNTS, [
      tx({ accountId: "checking", date: "2026-09-22", amount: -30000, transferAccountId: "broker", categoryId: "investing" }),
      tx({ accountId: "broker", date: "2026-09-22", amount: 30000, transferAccountId: "checking" }),
      tx({ accountId: "broker", date: "2026-09-30", amount: 1200 }), // dividend inside the broker account
    ]);

    assert.deepEqual(result.activity, [{ categoryId: "investing", month: "2026-09", amount: -30000 }]);
  });

  it("rejects invalid transactions with translatable error codes", () => {
    const cases: [BudgetTransaction, string][] = [
      [tx({ accountId: "nowhere", date: "2026-09-01", amount: -100, categoryId: "fun" }), "unknown_account"],
      [tx({ accountId: "checking", date: "2026-09-31", amount: -100, categoryId: "fun" }), "invalid_date"],
      [tx({ accountId: "checking", date: "2026-09-01", amount: -1.5, categoryId: "fun" }), "invalid_amount"],
      [tx({ accountId: "checking", date: "2026-09-01", amount: -100 }), "uncategorized_transaction"],
      [
        tx({
          accountId: "checking",
          date: "2026-09-01",
          amount: -100,
          splits: [{ categoryId: "fun", amount: -60 }],
        }),
        "split_mismatch",
      ],
      [tx({ accountId: "visa", date: "2026-09-01", amount: 500, categoryId: UNASSIGNED }), "unsupported_transaction"],
    ];
    for (const [transaction, code] of cases) {
      assert.throws(
        () => aggregateTransactions(ACCOUNTS, [transaction]),
        (error) => isValidationError(error, code as never),
        `expected ${code}`,
      );
    }
    assert.throws(
      () => aggregateTransactions([{ id: "amex", type: "credit", onBudget: true }], []),
      (error) => isValidationError(error, "missing_payment_category"),
    );
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

describe("budget invariant with accounts and credit cards", () => {
  // Whatever happens, the money in the budget must match the money in the accounts:
  //   unassigned money + available of every category and payment category
  //   + assigned in future + this month's credit overspending
  //   = balance of the on-budget cash accounts
  // Credit overspending is added back because it is spending that no cash covers yet: card debt.
  it("balances on 300 random histories", () => {
    const random = randomGenerator(7);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const amount = (max: number) => Math.floor(random() * max) + 1;
    const months = ["2026-01", "2026-02", "2026-03", "2026-04"];
    const date = () => `${pick(months)}-${String(amount(28)).padStart(2, "0")}`;
    const categoryIds = ["groceries", "rent", "fun", "investing"];
    const accounts: BudgetAccount[] = [
      { id: "checking", type: "cash", onBudget: true },
      { id: "wallet", type: "cash", onBudget: true },
      { id: "visa", type: "credit", onBudget: true, paymentCategoryId: "visa-payment" },
      { id: "amex", type: "credit", onBudget: true, paymentCategoryId: "amex-payment" },
      { id: "broker", type: "cash", onBudget: false },
    ];
    const paymentCategoryIds = ["visa-payment", "amex-payment"];

    for (let run = 0; run < 300; run++) {
      const transactions: BudgetTransaction[] = [];
      let n = 0;
      const add = (t: Omit<BudgetTransaction, "id">) => transactions.push({ id: `r${run}-${n++}`, ...t });

      for (let i = 0; i < 40; i++) {
        const d = date();
        switch (Math.floor(random() * 7)) {
          case 0: // income
            add({ accountId: pick(["checking", "wallet"]), date: d, amount: amount(300000), categoryId: UNASSIGNED });
            break;
          case 1: // cash spending or refund
            add({ accountId: pick(["checking", "wallet"]), date: d, amount: amount(60000) * pick([-1, -1, -1, 1]), categoryId: pick(categoryIds) });
            break;
          case 2: // card spending or refund
            add({ accountId: pick(["visa", "amex"]), date: d, amount: amount(60000) * pick([-1, -1, -1, 1]), categoryId: pick(categoryIds) });
            break;
          case 3: {
            // split spending
            const a = amount(30000);
            const b = amount(30000);
            add({
              accountId: pick(["checking", "visa"]),
              date: d,
              amount: -(a + b),
              splits: [
                { categoryId: pick(categoryIds), amount: -a },
                { categoryId: pick(categoryIds), amount: -b },
              ],
            });
            break;
          }
          case 4: {
            // card payment or cash advance, both sides
            const card = pick(["visa", "amex"]);
            const a = amount(80000) * pick([1, 1, 1, -1]);
            add({ accountId: "checking", date: d, amount: -a, transferAccountId: card });
            add({ accountId: card, date: d, amount: a, transferAccountId: "checking" });
            break;
          }
          case 5: {
            // transfer between cash accounts, both sides
            const a = amount(50000);
            add({ accountId: "checking", date: d, amount: -a, transferAccountId: "wallet" });
            add({ accountId: "wallet", date: d, amount: a, transferAccountId: "checking" });
            break;
          }
          default: {
            // investment: from checking to the off-budget broker
            const a = amount(40000);
            add({ accountId: "checking", date: d, amount: -a, transferAccountId: "broker", categoryId: "investing" });
            add({ accountId: "broker", date: d, amount: a, transferAccountId: "checking" });
          }
        }
      }

      const aggregated = aggregateTransactions(accounts, transactions);
      // A starting balance (or any card debt tracked outside the budget) is external to
      // the invariant: it must never move money between the budget and the cash accounts.
      const cardBalances = paymentCategoryIds.map((id) => ({ paymentCategoryId: id, owed: amount(300000) }));
      const input: BudgetInput = {
        categoryIds,
        paymentCategoryIds,
        ...aggregated,
        assignments: Array.from({ length: 20 }, () => ({
          categoryId: pick([...categoryIds, ...paymentCategoryIds]),
          month: pick(months),
          amount: amount(100000) - 30000,
        })),
        cardBalances,
      };
      const month = pick(months);

      const result = computeBudgetMonth(input, month);

      const budgeted =
        result.unassigned +
        [...result.categories, ...result.paymentCategories].reduce((sum, c) => sum + c.available, 0) +
        result.assignedInFuture +
        result.creditOverspending;
      const cashBalance = transactions
        .filter((t) => (t.accountId === "checking" || t.accountId === "wallet") && t.date.slice(0, 7) <= month)
        .reduce((sum, t) => sum + t.amount, 0);

      assert.equal(budgeted, cashBalance, `invariant violated on run ${run}, month ${month}`);

      for (const card of result.paymentCategories) {
        const owed = cardBalances.find((b) => b.paymentCategoryId === card.categoryId)?.owed ?? 0;
        assert.ok(card.uncovered >= 0, `uncovered went negative on run ${run}, month ${month}`);
        assert.equal(
          card.uncovered,
          Math.max(0, owed - Math.max(0, card.available)),
          `uncovered formula mismatch on run ${run}, month ${month}`,
        );
      }
    }
  });
});
