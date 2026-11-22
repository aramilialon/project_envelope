import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { MAX_AMOUNT_CENTS } from "../money.ts";
import { mulberry32 } from "../testing/random.ts";
import type { BudgetInput } from "./budget-month.ts";
import { computeBudgetMonth } from "./budget-month.ts";
import { owedAsOf } from "./card-balance.ts";
import { computeTodos, reservationShortfall } from "../presentation/todos.ts";
import { shiftMonth } from "../month.ts";
import type { BudgetAccount, BudgetTransaction } from "./transactions.ts";
import { aggregateTransactions, UNASSIGNED } from "./transactions.ts";

const ACCOUNTS: readonly BudgetAccount[] = [
  { id: "checking", type: "cash", onBudget: true },
  { id: "savings", type: "cash", onBudget: true },
  { id: "visa", type: "credit", onBudget: true, paymentCategoryId: "visa-payment" },
  { id: "amex", type: "credit", onBudget: true, paymentCategoryId: "amex-payment" },
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

    assert.deepEqual(result.income, [{ month: "2026-09", date: "2026-09-01", amount: 200000 }]);
    assert.deepEqual(result.activity, [{ categoryId: "groceries", month: "2026-09", date: "2026-09-03", amount: -4550 }]);
    assert.deepEqual(result.cardPayments, []);
  });

  it("tags credit card activity with the card's payment category", () => {
    const result = aggregateTransactions(ACCOUNTS, [
      tx({ accountId: "visa", date: "2026-09-05", amount: -3000, categoryId: "fun" }),
    ]);

    assert.deepEqual(result.activity, [
      { categoryId: "fun", month: "2026-09", date: "2026-09-05", amount: -3000, paymentCategoryId: "visa-payment" },
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

  it("counts a transfer between two credit cards once, from the outflow leg: that card is charged, the other paid (#732)", () => {
    const outflow = tx({ accountId: "visa", date: "2026-09-20", amount: -40000, transferAccountId: "amex" });
    const result = aggregateTransactions(ACCOUNTS, [
      tx({ accountId: "amex", date: "2026-09-20", amount: 40000, transferAccountId: "visa" }),
      outflow,
    ]);

    assert.deepEqual(result.cardTransfers, [
      {
        paidPaymentCategoryId: "amex-payment",
        chargedPaymentCategoryId: "visa-payment",
        month: "2026-09",
        date: "2026-09-20",
        id: outflow.id,
        amount: 40000,
      },
    ]);
    assert.deepEqual(result.cardPayments, []);
    assert.deepEqual(result.activity, []);
  });

  it("treats a transfer to an off-budget account as categorized activity, and ignores off-budget accounts", () => {
    const result = aggregateTransactions(ACCOUNTS, [
      tx({ accountId: "checking", date: "2026-09-22", amount: -30000, transferAccountId: "broker", categoryId: "investing" }),
      tx({ accountId: "broker", date: "2026-09-22", amount: 30000, transferAccountId: "checking" }),
      tx({ accountId: "broker", date: "2026-09-30", amount: 1200 }), // dividend inside the broker account
    ]);

    assert.deepEqual(result.activity, [{ categoryId: "investing", month: "2026-09", date: "2026-09-22", amount: -30000 }]);
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

describe("money coming back from an off-budget account (#598)", () => {
  // The domain review's example: September 2026, checking holds €3,000, of which €200 is
  // unassigned, €1,800 in Groceries and €1,000 in Rent; Investing holds nothing.
  const categoryIds = ["groceries", "rent", "investing"];
  const september: BudgetTransaction[] = [
    { id: "salary", accountId: "checking", date: "2026-09-01", amount: 300000, categoryId: UNASSIGNED },
  ];
  const assignments = [
    { categoryId: "groceries", month: "2026-09", amount: 180000 },
    { categoryId: "rent", month: "2026-09", amount: 100000 },
  ];
  const budget = (transactions: readonly BudgetTransaction[], month: string, extra: BudgetInput["assignments"] = []) => {
    const aggregated = aggregateTransactions(ACCOUNTS, transactions);
    return computeBudgetMonth(
      { categoryIds, paymentCategoryIds: ["visa-payment", "amex-payment"], ...aggregated, assignments: [...assignments, ...extra], today: "2026-12-31" },
      month,
    );
  };
  const available = (month: ReturnType<typeof computeBudgetMonth>, id: string) =>
    month.categories.find((c) => c.categoryId === id)?.available;
  const balance = (transactions: readonly BudgetTransaction[]) =>
    transactions.filter((t) => t.accountId === "checking").reduce((sum, t) => sum + t.amount, 0);
  const total = (month: ReturnType<typeof computeBudgetMonth>) =>
    month.unassigned + month.categories.reduce((sum, c) => sum + c.available, 0);

  it("counts an uncategorized incoming leg as income to assign (example 1)", () => {
    const before = budget(september, "2026-09");
    assert.equal(before.unassigned, 20000);

    const transactions = [
      ...september,
      { id: "sale", accountId: "checking", date: "2026-09-15", amount: 500000, transferAccountId: "broker" },
      { id: "sale-broker", accountId: "broker", date: "2026-09-15", amount: -500000, transferAccountId: "checking" },
    ];
    const aggregated = aggregateTransactions(ACCOUNTS, transactions);
    assert.deepEqual(aggregated.income, [
      { month: "2026-09", date: "2026-09-01", amount: 300000 },
      { month: "2026-09", date: "2026-09-15", amount: 500000 },
    ]);
    assert.deepEqual(aggregated.activity, []);

    const after = budget(transactions, "2026-09");
    assert.equal(after.unassigned, 520000);
    assert.equal(available(after, "groceries"), 180000);
    assert.equal(available(after, "rent"), 100000);
    assert.equal(available(after, "investing"), 0);
    assert.equal(balance(transactions), 800000);
    assert.equal(total(after), balance(transactions));
  });

  it("keeps an incoming leg with a real category as that category's activity (example 2)", () => {
    const transactions = [
      ...september,
      { id: "sale", accountId: "checking", date: "2026-09-15", amount: 500000, transferAccountId: "broker", categoryId: "investing" },
      { id: "sale-broker", accountId: "broker", date: "2026-09-15", amount: -500000, transferAccountId: "checking" },
    ];
    const after = budget(transactions, "2026-09");
    assert.equal(after.unassigned, 20000);
    assert.equal(available(after, "investing"), 500000);
    assert.equal(total(after), balance(transactions));
  });

  it("leaves the month the money went out in unchanged when it comes back as income later (example 3)", () => {
    const june: BudgetTransaction[] = [
      { id: "june-salary", accountId: "checking", date: "2026-06-01", amount: 500000, categoryId: UNASSIGNED },
      { id: "invest", accountId: "checking", date: "2026-06-10", amount: -500000, transferAccountId: "broker", categoryId: "investing" },
      { id: "invest-broker", accountId: "broker", date: "2026-06-10", amount: 500000, transferAccountId: "checking" },
    ];
    const funding = [{ categoryId: "investing", month: "2026-06", amount: 500000 }];
    const comeBack: BudgetTransaction[] = [
      { id: "sale", accountId: "checking", date: "2026-09-15", amount: 500000, transferAccountId: "broker" },
      { id: "sale-broker", accountId: "broker", date: "2026-09-15", amount: -500000, transferAccountId: "checking" },
    ];
    const without = [...june, ...september];
    const withReturn = [...without, ...comeBack];

    assert.deepEqual(budget(withReturn, "2026-06", funding).categories, budget(without, "2026-06", funding).categories);
    assert.equal(budget(withReturn, "2026-06", funding).categories.find((c) => c.categoryId === "investing")?.activity, -500000);
    const septemberWithout = budget(without, "2026-09", funding);
    const septemberWith = budget(withReturn, "2026-09", funding);
    assert.equal(septemberWith.unassigned - septemberWithout.unassigned, 500000);
    assert.deepEqual(septemberWith.categories, septemberWithout.categories);
    assert.equal(total(septemberWith), balance(withReturn));
  });

  it("refuses an outgoing leg without a real category, and a card leg without one (example 5)", () => {
    const cases: [BudgetTransaction, string][] = [
      // checking -> broker without a category, or with its outgoing leg edited to none
      [tx({ accountId: "checking", date: "2026-09-15", amount: -500000, transferAccountId: "broker" }), "uncategorized_transaction"],
      // the outgoing leg cannot be income to assign either: that would be negative income
      [
        tx({ accountId: "checking", date: "2026-09-15", amount: -500000, transferAccountId: "broker", categoryId: UNASSIGNED }),
        "uncategorized_transaction",
      ],
      // broker -> Visa without a category
      [tx({ accountId: "visa", date: "2026-09-15", amount: 500000, transferAccountId: "broker" }), "unsupported_transaction"],
      [tx({ accountId: "visa", date: "2026-09-15", amount: 500000, transferAccountId: "broker", categoryId: UNASSIGNED }), "unsupported_transaction"],
      // Visa -> broker without a category
      [tx({ accountId: "visa", date: "2026-09-15", amount: -500000, transferAccountId: "broker" }), "unsupported_transaction"],
    ];
    for (const [transaction, code] of cases) {
      assert.throws(
        () => aggregateTransactions(ACCOUNTS, [transaction]),
        (error) => isValidationError(error, code as never),
        `expected ${code} for ${JSON.stringify(transaction)}`,
      );
    }
  });

  it("still reads a categorized incoming leg on a card as a refund on that card", () => {
    const result = aggregateTransactions(ACCOUNTS, [
      tx({ accountId: "visa", date: "2026-09-15", amount: 20000, transferAccountId: "broker", categoryId: "investing" }),
    ]);
    assert.deepEqual(result.activity, [{ categoryId: "investing", month: "2026-09", date: "2026-09-15", amount: 20000, paymentCategoryId: "visa-payment" }]);
    assert.deepEqual(result.income, []);
  });
});

describe("money coming in dated after today (#668)", () => {
  // Today is 21 November 2026: €2,000 of salary, €300 assigned to Groceries and €100 to Household.
  const categoryIds = ["groceries", "household", "investing"];
  const november: BudgetTransaction[] = [
    { id: "salary", accountId: "checking", date: "2026-11-02", amount: 200000, categoryId: UNASSIGNED },
  ];
  const assignments = [
    { categoryId: "groceries", month: "2026-11", amount: 30000 },
    { categoryId: "household", month: "2026-11", amount: 10000 },
  ];
  const budget = (transactions: readonly BudgetTransaction[], today: string) =>
    computeBudgetMonth(
      { categoryIds, paymentCategoryIds: ["visa-payment", "amex-payment"], ...aggregateTransactions(ACCOUNTS, transactions), assignments, today },
      "2026-11",
    );
  const find = (list: ReturnType<typeof computeBudgetMonth>["categories"], id: string) => list.find((c) => c.categoryId === id);

  it("a card refund dated after today moves nothing until its date", () => {
    const spent: BudgetTransaction[] = [
      ...november,
      { id: "shop", accountId: "visa", date: "2026-11-10", amount: -8000, categoryId: "groceries" },
    ];
    const refunded = [...spent, { id: "refund", accountId: "visa", date: "2026-11-28", amount: 3000, categoryId: "groceries" }];

    const before = budget(refunded, "2026-11-21");
    assert.deepEqual(before, budget(spent, "2026-11-21"));
    assert.equal(find(before.categories, "groceries")?.available, 22000);
    assert.equal(find(before.paymentCategories, "visa-payment")?.available, 8000);

    const onTheDay = budget(refunded, "2026-11-28");
    assert.equal(find(onTheDay.categories, "groceries")?.available, 25000);
    assert.equal(find(onTheDay.paymentCategories, "visa-payment")?.available, 5000);
  });

  it("a receipt with a return on it dated after today: the spending counts at once, the return from its date", () => {
    // −€100 at the store on the 25th: €150 of groceries, €50 back on a household return.
    const transactions: BudgetTransaction[] = [
      ...november,
      {
        id: "receipt",
        accountId: "checking",
        date: "2026-11-25",
        amount: -10000,
        splits: [
          { categoryId: "groceries", amount: -15000 },
          { categoryId: "household", amount: 5000 },
        ],
      },
    ];

    const before = budget(transactions, "2026-11-21");
    assert.equal(find(before.categories, "groceries")?.available, 15000);
    assert.equal(find(before.categories, "household")?.available, 10000);
    assert.equal(before.unassigned, 160000);

    const onTheDay = budget(transactions, "2026-11-25");
    assert.equal(find(onTheDay.categories, "groceries")?.available, 15000);
    assert.equal(find(onTheDay.categories, "household")?.available, 15000);
    assert.equal(onTheDay.unassigned, 160000);
  });

  it("a categorized transfer in from an off-budget account dated after today counts nowhere until its date", () => {
    const transactions: BudgetTransaction[] = [
      ...november,
      { id: "sale", accountId: "checking", date: "2026-11-28", amount: 50000, transferAccountId: "broker", categoryId: "investing" },
      { id: "sale-broker", accountId: "broker", date: "2026-11-28", amount: -50000, transferAccountId: "checking" },
    ];

    const before = budget(transactions, "2026-11-21");
    assert.deepEqual(before, budget(november, "2026-11-21"));
    assert.equal(find(before.categories, "investing")?.available, 0);
    assert.equal(before.unassigned, 160000);

    const onTheDay = budget(transactions, "2026-11-28");
    assert.equal(find(onTheDay.categories, "investing")?.available, 50000);
    assert.equal(onTheDay.unassigned, 160000);
  });
});

describe("budget invariant with accounts and credit cards", () => {
  // Whatever happens, the money in the budget must match the money in the accounts:
  //   unassigned money + available of every category and payment category
  //   + assigned in future + this month's credit overspending + this month's reserved
  //   = balance of the on-budget cash accounts at the end of the month, less every positive split
  //     dated after today on them: income, a refund, a categorized transfer in from the broker
  //     (not received yet, so it counts nowhere: rule 1, #668). Transfers between two on-budget
  //     accounts are not splits and stay in the balance.
  // Credit overspending is added back because it is spending that no cash covers yet: card
  // debt. Reserved is added back for the same reason: a scheduled item not yet recorded has
  // not moved any real cash either, only reduced a category's own reported available.
  it("balances on 300 random histories", () => {
    const random = mulberry32(7);
    // How many months checked a payment category held negative by a card in credit (#660), so
    // that the test is not vacuous.
    let inCredit = 0;
    let carriedNegative = 0;
    let settledMonths = 0;
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
    // Income: money in UNASSIGNED, and an uncategorized leg coming in from the off-budget
    // broker (#598). Income dated after today is left out of the balance below.
    const isIncome = (t: BudgetTransaction) =>
      t.categoryId === UNASSIGNED || (t.transferAccountId === "broker" && t.categoryId === undefined && t.amount > 0);
    const onBudgetIds = new Set(accounts.filter((a) => a.onBudget).map((a) => a.id));
    // What of a cash transaction is not received by today (#668): every positive split of it dated
    // after today — income, a refund, a categorized transfer in from the broker — but never a
    // transfer between two on-budget accounts.
    const notReceived = (t: BudgetTransaction, today: string): number => {
      if (t.date <= today) return 0;
      if (t.transferAccountId !== undefined && onBudgetIds.has(t.transferAccountId)) return 0;
      if (isIncome(t)) return t.amount;
      const parts = t.splits !== undefined && t.splits.length > 0 ? t.splits.map((s) => s.amount) : [t.amount];
      return parts.filter((a) => a > 0).reduce((sum, a) => sum + a, 0);
    };

    for (let run = 0; run < 300; run++) {
      const transactions: BudgetTransaction[] = [];
      let n = 0;
      const add = (t: Omit<BudgetTransaction, "id">) => transactions.push({ id: `r${run}-${n++}`, ...t });

      for (let i = 0; i < 40; i++) {
        const d = date();
        switch (Math.floor(random() * 9)) {
          case 0: // income, or now and then money going out of Unassigned (negative income, #782)
            add({ accountId: pick(["checking", "wallet"]), date: d, amount: amount(300000) * pick([1, 1, 1, 1, -1]), categoryId: UNASSIGNED });
            break;
          case 1: // cash spending or refund
            add({ accountId: pick(["checking", "wallet"]), date: d, amount: amount(60000) * pick([-1, -1, -1, 1]), categoryId: pick(categoryIds) });
            break;
          case 2: // card spending or refund
            add({ accountId: pick(["visa", "amex"]), date: d, amount: amount(60000) * pick([-1, -1, -1, 1]), categoryId: pick(categoryIds) });
            break;
          case 3: {
            // split spending, or a receipt with a return on it (#668): one split positive
            const a = amount(30000);
            const b = amount(30000) * pick([-1, -1, 1]);
            add({
              accountId: pick(["checking", "visa"]),
              date: d,
              amount: -a + b,
              splits: [
                { categoryId: pick(categoryIds), amount: -a },
                { categoryId: pick(categoryIds), amount: b },
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
          case 6: {
            // card-to-card transfer (#260), both sides
            const forward = random() < 0.5;
            const source = forward ? "visa" : "amex";
            const destination = forward ? "amex" : "visa";
            const a = amount(50000);
            add({ accountId: source, date: d, amount: -a, transferAccountId: destination });
            add({ accountId: destination, date: d, amount: a, transferAccountId: source });
            break;
          }
          case 7: {
            // investment: from checking to the off-budget broker
            const a = amount(40000);
            add({ accountId: "checking", date: d, amount: -a, transferAccountId: "broker", categoryId: "investing" });
            add({ accountId: "broker", date: d, amount: a, transferAccountId: "checking" });
            break;
          }
          default: {
            // money back from the broker (#598): half of it as income to assign, half in a category
            const a = amount(40000);
            const destination = pick(["checking", "wallet"]);
            add({
              accountId: destination,
              date: d,
              amount: a,
              transferAccountId: "broker",
              ...(random() < 0.5 ? {} : { categoryId: pick(categoryIds) }),
            });
            add({ accountId: "broker", date: d, amount: -a, transferAccountId: destination });
          }
        }
      }

      const aggregated = aggregateTransactions(accounts, transactions);
      // Each card's real balance comes from its own transactions, after a starting balance (or a
      // card in credit from the start) dated in the first month: refunds after a payment leave a
      // card in credit now and then (#660). A starting balance is external to the invariant: it
      // must never move money between the budget and the cash accounts.
      const cardBalances = paymentCategoryIds.map((id) => {
        const accountId = id === "visa-payment" ? "visa" : "amex";
        const start = pick([0, amount(300000), -amount(30000)]);
        return {
          paymentCategoryId: id,
          transactions: [
            { date: "2026-01-01", amount: 0 - start },
            ...transactions.filter((t) => t.accountId === accountId).map((t) => ({ date: t.date, amount: t.amount })),
          ],
        };
      });
      // Today falls inside the history most of the time, so some income is not received yet.
      const today = random() < 0.25 ? "2026-12-31" : date();
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
        // Not yet recorded, so no real cash moved for these — reserved is added back below,
        // the same way creditOverspending already is.
        scheduledItems: Array.from({ length: 5 }, () => ({ categoryId: pick(categoryIds), amount: amount(50000) })),
        today,
      };
      // Every month of the history, so that a card's credit carried from one month into the next
      // is checked on both sides (#660), and a month before negative income as well as its own (#782).
      let previous: ReturnType<typeof computeBudgetMonth> | undefined;
      for (const month of months) {
        const result = computeBudgetMonth(input, month);

        const budgeted =
          result.unassigned +
          [...result.categories, ...result.paymentCategories].reduce((sum, c) => sum + c.available, 0) +
          result.assignedInFuture +
          result.creditOverspending +
          result.reserved;
        const cashBalance = transactions
          .filter((t) => t.accountId === "checking" || t.accountId === "wallet")
          .filter((t) => t.date.slice(0, 7) <= month)
          .reduce((sum, t) => sum + t.amount - notReceived(t, today), 0);

        assert.equal(budgeted, cashBalance, `invariant violated on run ${run}, month ${month}`);

        for (const card of result.paymentCategories) {
          const own = cardBalances.find((b) => b.paymentCategoryId === card.categoryId)?.transactions ?? [];
          const owed = owedAsOf(own, month);
          const credit = Math.max(0, -owed);
          assert.equal(card.owed, owed, `owed mismatch on run ${run}, month ${month}`);
          assert.ok(card.uncovered >= 0, `uncovered went negative on run ${run}, month ${month}`);
          assert.equal(
            card.uncovered,
            Math.max(0, owed - Math.max(0, card.available)),
            `uncovered formula mismatch on run ${run}, month ${month}`,
          );
          // Rule 9 (#660): only the part beyond the card's credit is cash overspending, and what
          // carries over into this month is no lower than minus the card's credit at the end of
          // the month before.
          assert.equal(card.cashOverspending, Math.max(0, -card.available - credit), `cash overspending on run ${run}, month ${month}`);
          const previousCredit = Math.max(0, -owedAsOf(own, shiftMonth(month, -1)));
          assert.ok(card.carriedOver >= -previousCredit, `carried over below the credit on run ${run}, month ${month}`);
          if (card.available < 0 && credit > 0) inCredit++;
          if (card.carriedOver < 0) carriedNegative++;
          // What the month before kept: its available, less only its cash overspending.
          const before = previous?.paymentCategories.find((c) => c.categoryId === card.categoryId);
          const kept = before === undefined ? 0 : before.available < 0 ? before.available + before.cashOverspending : before.available;
          assert.equal(card.carriedOver, kept, `carried over on run ${run}, month ${month}`);
        }

        // Following the month's "To do" list once settles it (#731, #732): every card's payment
        // category holds at least what the card owes, no category is overspent in cash or short of
        // its reservation, and the list asks for nothing more — card-to-card transfers included.
        const asked = computeTodos({
          unassignedCents: result.unassigned,
          categories: result.categories,
          paymentCategories: result.paymentCategories,
          overdueScheduledItems: [],
          targetsNeeded: [],
        }).flatMap((item) => ("categoryId" in item && item.categoryId !== null ? [{ categoryId: item.categoryId, month, amount: item.amountCents }] : []));
        const settled = computeBudgetMonth({ ...input, assignments: [...input.assignments, ...asked] }, month);
        for (const card of settled.paymentCategories) {
          assert.ok(card.available >= (card.owed ?? 0), `card ${card.categoryId} not settled on run ${run}, month ${month}`);
          assert.equal(card.cashOverspending, 0, `card ${card.categoryId} overspent after settling on run ${run}, month ${month}`);
        }
        for (const c of settled.categories) {
          assert.equal(c.cashOverspending, 0, `category ${c.categoryId} overspent after settling on run ${run}, month ${month}`);
          assert.equal(reservationShortfall(c), 0, `reservation of ${c.categoryId} short after settling on run ${run}, month ${month}`);
        }
        if (asked.length > 0) settledMonths++;
        previous = result;
      }
    }
    assert.ok(inCredit > 10, `only ${inCredit} months had a payment category held negative by a card in credit`);
    assert.ok(carriedNegative > 5, `only ${carriedNegative} months carried a card's credit over`);
    assert.ok(settledMonths > 600, `only ${settledMonths} months had something to settle`);
  });
});

describe("amounts at the cap (#651, ADR 0002)", () => {
  const budgetOf = (transactions: readonly BudgetTransaction[], month: string) => {
    const aggregated = aggregateTransactions(ACCOUNTS, transactions);
    return computeBudgetMonth(
      {
        categoryIds: ["groceries"],
        paymentCategoryIds: ["visa-payment", "amex-payment"],
        income: aggregated.income,
        assignments: [],
        activity: aggregated.activity,
        cardPayments: aggregated.cardPayments,
        cardTransfers: aggregated.cardTransfers,
        today: "2026-12-31",
      },
      month,
    );
  };

  it("two transfers in at the cap from an off-budget account still give a readable budget month", () => {
    const month = budgetOf(
      [
        tx({ accountId: "checking", date: "2026-09-01", amount: MAX_AMOUNT_CENTS, transferAccountId: "broker" }),
        tx({ accountId: "broker", date: "2026-09-01", amount: -MAX_AMOUNT_CENTS, transferAccountId: "checking" }),
        tx({ accountId: "checking", date: "2026-09-02", amount: MAX_AMOUNT_CENTS, transferAccountId: "broker" }),
        tx({ accountId: "broker", date: "2026-09-02", amount: -MAX_AMOUNT_CENTS, transferAccountId: "checking" }),
      ],
      "2026-09",
    );
    assert.equal(month.unassigned, 2 * MAX_AMOUNT_CENTS);
  });

  it("names the transactions above the cap when the on-budget amounts add up beyond the safe range", () => {
    // Only rows stored before the cap can be this large: the API refuses them on every write path.
    const legacy = [
      tx({ accountId: "checking", date: "2026-09-01", amount: Number.MAX_SAFE_INTEGER, categoryId: UNASSIGNED }),
      tx({ accountId: "checking", date: "2026-09-02", amount: 100, categoryId: UNASSIGNED }),
      tx({ accountId: "checking", date: "2026-09-03", amount: Number.MAX_SAFE_INTEGER - 1, categoryId: UNASSIGNED }),
    ];
    assert.throws(
      () => budgetOf(legacy, "2026-09"),
      (error) =>
        isValidationError(error, "amount_total_overflow") &&
        error.details.label === "transactions" &&
        error.details.transactionIds === `${legacy[0]!.id},${legacy[2]!.id}` &&
        error.details.count === 2,
    );
  });

  it("names at most 20 transactions, and counts them all", () => {
    const legacy = Array.from({ length: 25 }, (_, i) =>
      tx({ accountId: "checking", date: "2026-09-01", amount: Math.floor(Number.MAX_SAFE_INTEGER / 10) - i, categoryId: UNASSIGNED }),
    );
    assert.throws(
      () => budgetOf(legacy, "2026-09"),
      (error) =>
        isValidationError(error, "amount_total_overflow") &&
        String(error.details.transactionIds).split(",").length === 20 &&
        error.details.count === 25,
    );
  });

  it("names the largest transactions when none is above the cap, and ignores off-budget accounts", () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      tx({ accountId: "checking", date: "2026-09-01", amount: MAX_AMOUNT_CENTS - i, categoryId: UNASSIGNED }),
    );
    // A huge off-budget row takes no part in the budget, so it cannot make it unreadable.
    const offBudget = tx({ accountId: "broker", date: "2026-09-01", amount: Number.MAX_SAFE_INTEGER, categoryId: UNASSIGNED });
    assert.equal(budgetOf([...rows, offBudget], "2026-09").unassigned, 3 * MAX_AMOUNT_CENTS - 3);
  });
});
