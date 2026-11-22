import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { owing } from "../testing/card-balance.ts";
import { mulberry32 } from "../testing/random.ts";
import type { BudgetInput, CategoryMonth } from "./budget-month.ts";
import { shiftMonth } from "../month.ts";
import { MAX_AMOUNT_CENTS } from "../money.ts";
import { computeBudgetMonth } from "./budget-month.ts";

/** Finds a category in the result, failing the test if it is missing. */
function category(categories: readonly CategoryMonth[], id: string): CategoryMonth {
  const found = categories.find((c) => c.categoryId === id);
  assert.ok(found, `category ${id} missing`);
  return found;
}

/** A fixed today after all the data in these examples, unless a test says otherwise. */
const TODAY = "2026-12-31";

const EMPTY: BudgetInput = { categoryIds: [], income: [], assignments: [], activity: [], today: TODAY };

describe("computeBudgetMonth", () => {
  it("only money that has arrived can be assigned", () => {
    const input: BudgetInput = {
      today: TODAY,
      categoryIds: ["groceries", "rent"],
      income: [{ month: "2026-09", amount: 200000 }],
      assignments: [
        { categoryId: "groceries", month: "2026-09", amount: 40000 },
        { categoryId: "rent", month: "2026-09", amount: 90000 },
      ],
      activity: [{ categoryId: "groceries", month: "2026-09", amount: -35000 }],
    };

    const result = computeBudgetMonth(input, "2026-09");

    assert.equal(result.unassigned, 70000); // 2000 − 400 − 900 = €700
    assert.equal(category(result.categories, "groceries").available, 5000); // 400 − 350 = €50
    assert.equal(category(result.categories, "rent").available, 90000);
  });

  it("a positive available balance rolls over to the next month", () => {
    const input: BudgetInput = {
      today: TODAY,
      categoryIds: ["groceries"],
      income: [{ month: "2026-09", amount: 100000 }],
      assignments: [
        { categoryId: "groceries", month: "2026-09", amount: 40000 },
        { categoryId: "groceries", month: "2026-10", amount: 40000 },
      ],
      activity: [{ categoryId: "groceries", month: "2026-09", amount: -35000 }],
    };

    const october = category(computeBudgetMonth(input, "2026-10").categories, "groceries");

    assert.equal(october.carriedOver, 5000);
    assert.equal(october.available, 45000);
  });

  it("overspending left at the end of a month is taken from unassigned money the next month", () => {
    const input: BudgetInput = {
      today: TODAY,
      categoryIds: ["fun"],
      income: [{ month: "2026-09", amount: 50000 }],
      assignments: [{ categoryId: "fun", month: "2026-09", amount: 10000 }],
      activity: [{ categoryId: "fun", month: "2026-09", amount: -15000 }],
    };

    const september = computeBudgetMonth(input, "2026-09");
    assert.equal(category(september.categories, "fun").available, -5000); // overspent by €50
    assert.equal(september.unassigned, 40000); // nothing changes yet within the month

    const october = computeBudgetMonth(input, "2026-10");
    assert.equal(category(october.categories, "fun").available, 0); // restarts at zero
    assert.equal(october.overspentLastMonth, 5000);
    assert.equal(october.unassigned, 35000); // 500 − 100 − 50 = €350
  });

  it("a scheduled item not yet recorded reserves its amount, net from available", () => {
    const input: BudgetInput = {
      today: TODAY,
      categoryIds: ["rent"],
      income: [{ month: "2026-09", amount: 100000 }],
      assignments: [{ categoryId: "rent", month: "2026-09", amount: 90000 }],
      activity: [],
      scheduledItems: [{ categoryId: "rent", amount: 90000 }],
    };

    const result = computeBudgetMonth(input, "2026-09");

    const rent = category(result.categories, "rent");
    assert.equal(rent.reserved, 90000);
    assert.equal(rent.available, 0); // 900 assigned − 900 reserved
    assert.equal(result.reserved, 90000);
  });

  it("a reservation beyond what a category can cover is a warning, not overspending", () => {
    const input: BudgetInput = {
      today: TODAY,
      categoryIds: ["rent"],
      income: [{ month: "2026-09", amount: 50000 }],
      assignments: [{ categoryId: "rent", month: "2026-09", amount: 50000 }],
      activity: [],
      scheduledItems: [{ categoryId: "rent", amount: 80000 }],
    };

    const result = computeBudgetMonth(input, "2026-09");

    const rent = category(result.categories, "rent");
    assert.equal(rent.available, -30000); // reservation exceeds what is assigned
    assert.equal(rent.cashOverspending, 0, "a reservation shortfall must never count as overspending");
    assert.equal(rent.creditOverspending, 0);
    assert.equal(result.overspentLastMonth, 0);
  });

  it("reservations do not carry over: a fresh month starts with none of the last one's shortfall", () => {
    const input: BudgetInput = {
      today: TODAY,
      categoryIds: ["rent"],
      income: [
        { month: "2026-09", amount: 50000 },
        { month: "2026-10", amount: 50000 },
      ],
      assignments: [
        { categoryId: "rent", month: "2026-09", amount: 50000 },
        { categoryId: "rent", month: "2026-10", amount: 50000 },
      ],
      activity: [],
      // Only ever reserves against the month actually requested (no month field of its own).
      scheduledItems: [{ categoryId: "rent", amount: 80000 }],
    };

    const september = computeBudgetMonth(input, "2026-09");
    assert.equal(category(september.categories, "rent").available, -30000);

    const october = computeBudgetMonth(input, "2026-10");
    // September's reservation shortfall never counted as real overspending (the previous test),
    // so it neither zeroed carriedOver nor reduced it: October's own carriedOver is September's
    // full, un-reserved 50000, on top of which October assigns another 50000 and reapplies the
    // very same still-outstanding item — 100000 now comfortably covers the 80000 reservation,
    // unaffected by September ever having fallen short of it.
    assert.equal(category(october.categories, "rent").carriedOver, 50000);
    assert.equal(category(october.categories, "rent").available, 20000);
    assert.equal(october.overspentLastMonth, 0);
  });

  it("money assigned to future months reduces unassigned money immediately", () => {
    const input: BudgetInput = {
      today: TODAY,
      categoryIds: ["rent"],
      income: [{ month: "2026-09", amount: 100000 }],
      assignments: [{ categoryId: "rent", month: "2026-10", amount: 90000 }],
      activity: [],
    };

    const september = computeBudgetMonth(input, "2026-09");

    assert.equal(september.unassigned, 10000);
    assert.equal(september.assignedInFuture, 90000);
  });

  it("a month's unassigned money never includes income dated after it (#650)", () => {
    // Nothing in August; a €3,000 salary in September.
    const input: BudgetInput = {
      ...EMPTY,
      income: [{ month: "2026-09", date: "2026-09-25", amount: 300000 }],
      today: "2026-11-21",
    };
    assert.equal(computeBudgetMonth(input, "2026-08").unassigned, 0);
    assert.equal(computeBudgetMonth(input, "2026-09").unassigned, 300000);

    // October's own income leaves August and September as they were.
    const withOctober: BudgetInput = {
      ...input,
      income: [...input.income, { month: "2026-10", date: "2026-10-25", amount: 300000 }],
    };
    assert.equal(computeBudgetMonth(withOctober, "2026-08").unassigned, 0);
    assert.equal(computeBudgetMonth(withOctober, "2026-09").unassigned, 300000);
    assert.equal(computeBudgetMonth(withOctober, "2026-10").unassigned, 600000);
  });

  it("income dated later than any real data cannot be assigned yet", () => {
    const input: BudgetInput = {
      ...EMPTY,
      income: [{ month: "2026-09", amount: 100000 }],
    };

    // Nothing in the data reaches November, so querying it sees no more than September already had.
    assert.equal(computeBudgetMonth(input, "2026-11").unassigned, 100000);
  });

  it("a future month's own income funding its own assignment does not create a false deficit in an earlier month (#488)", () => {
    const input: BudgetInput = {
      categoryIds: ["mortgage"],
      income: [
        { month: "2026-09", date: "2026-09-10", amount: 10000 }, // a small September income, unrelated
        { month: "2026-10", date: "2026-10-05", amount: 1680200 }, // October's own loan disbursement
      ],
      assignments: [{ categoryId: "mortgage", month: "2026-10", amount: 1680200 }],
      activity: [],
      today: "2026-11-21",
    };

    // Browsing back to September must not be blamed for an assignment only October's own,
    // later-arriving income actually funded.
    const september = computeBudgetMonth(input, "2026-09");
    assert.equal(september.unassigned, 10000);
    assert.equal(september.assignedInFuture, 0, "none of September's money went to October");
    assert.equal(computeBudgetMonth(input, "2026-10").unassigned, 10000);
  });

  it("assigning ahead takes the money from the month it comes from", () => {
    // €1,000 received in September, €900 of it assigned to October.
    const input: BudgetInput = {
      categoryIds: ["rent"],
      income: [{ month: "2026-09", date: "2026-09-25", amount: 100000 }],
      assignments: [{ categoryId: "rent", month: "2026-10", amount: 90000 }],
      activity: [],
      today: "2026-11-21",
    };

    const september = computeBudgetMonth(input, "2026-09");
    assert.equal(september.unassigned, 10000);
    assert.equal(september.assignedInFuture, 90000);
    const october = computeBudgetMonth(input, "2026-10");
    assert.equal(october.unassigned, 10000);
    assert.equal(october.assignedInFuture, 0);
  });

  it("over-assigning ahead shows in the month the money would come from", () => {
    // €1,000 received in September, €1,100 assigned to October, no October income.
    const input: BudgetInput = {
      categoryIds: ["rent"],
      income: [{ month: "2026-09", date: "2026-09-25", amount: 100000 }],
      assignments: [{ categoryId: "rent", month: "2026-10", amount: 110000 }],
      activity: [],
      today: "2026-11-21",
    };

    const september = computeBudgetMonth(input, "2026-09");
    assert.equal(september.unassigned, -10000);
    assert.equal(september.assignedInFuture, 110000);
    assert.equal(computeBudgetMonth(input, "2026-10").unassigned, -10000);
  });

  it("negative income counts from its own month on, never charged back to earlier months (#782)", () => {
    // €100 unassigned in September; a −€300 overdraft on checking recorded on Unassigned on 22 Nov.
    const input: BudgetInput = {
      categoryIds: ["rent"],
      income: [
        { month: "2026-09", date: "2026-09-10", amount: 10000 },
        { month: "2026-11", date: "2026-11-22", amount: -30000 },
      ],
      assignments: [],
      activity: [],
      today: "2026-11-22",
    };

    const september = computeBudgetMonth(input, "2026-09");
    assert.equal(september.unassigned, 10000);
    assert.equal(september.assignedInFuture, 0);
    const october = computeBudgetMonth(input, "2026-10");
    assert.equal(october.unassigned, 10000);
    assert.equal(october.assignedInFuture, 0);
    assert.equal(computeBudgetMonth(input, "2026-11").unassigned, -20000);
    assert.equal(computeBudgetMonth(input, "2026-12").unassigned, -20000);
  });

  it("a later month's assignment beyond its own positive income is still charged back, its negative income is not (#782, #488)", () => {
    // €1,000 in September. October: €500 in, −€300 out, €500 assigned to October.
    const input: BudgetInput = {
      categoryIds: ["rent"],
      income: [
        { month: "2026-09", date: "2026-09-10", amount: 100000 },
        { month: "2026-10", date: "2026-10-05", amount: 50000 },
        { month: "2026-10", date: "2026-10-06", amount: -30000 },
      ],
      assignments: [
        { categoryId: "rent", month: "2026-10", amount: 50000 },
        { categoryId: "rent", month: "2026-11", amount: 20000 },
      ],
      activity: [],
      today: "2026-11-22",
    };

    // October's own €500 pays its €500; November has no income, so its €200 comes from September.
    const september = computeBudgetMonth(input, "2026-09");
    assert.equal(september.unassigned, 80000);
    assert.equal(september.assignedInFuture, 20000);
    // October: €1,000 + €500 − €300 − €500, less the €200 November takes.
    const october = computeBudgetMonth(input, "2026-10");
    assert.equal(october.unassigned, 50000);
    assert.equal(october.assignedInFuture, 20000);
  });

  it("income dated after today counts nowhere until its date", () => {
    const input: BudgetInput = {
      categoryIds: ["groceries"],
      income: [
        { month: "2026-11", date: "2026-11-10", amount: 200000 },
        { month: "2026-11", date: "2026-11-27", amount: 50000 }, // expected, not received yet
        { month: "2026-12", date: "2026-12-10", amount: 200000 },
      ],
      assignments: [{ categoryId: "groceries", month: "2026-11", amount: 30000 }],
      // Spending dated after today (say the 25th) still counts against its category.
      activity: [{ categoryId: "groceries", month: "2026-11", amount: -5000 }],
      today: "2026-11-21",
    };

    const november = computeBudgetMonth(input, "2026-11");
    assert.equal(november.unassigned, 170000); // 2000 − 300, without the €500 due on the 27th
    assert.equal(category(november.categories, "groceries").available, 25000);
    assert.equal(computeBudgetMonth(input, "2026-12").unassigned, 170000, "nor in a later month");

    // On the 27th it has arrived.
    assert.equal(computeBudgetMonth({ ...input, today: "2026-11-27" }, "2026-11").unassigned, 220000);
  });

  it("a refund dated after today counts nowhere until its date (#668)", () => {
    const input: BudgetInput = {
      categoryIds: ["groceries", "household"],
      income: [{ month: "2026-11", date: "2026-11-05", amount: 200000 }],
      assignments: [
        { categoryId: "groceries", month: "2026-11", amount: 30000 },
        { categoryId: "household", month: "2026-11", amount: 10000 },
      ],
      activity: [{ categoryId: "groceries", month: "2026-11", date: "2026-11-28", amount: 20000 }],
      today: "2026-11-21",
    };

    const before = computeBudgetMonth(input, "2026-11");
    assert.equal(category(before.categories, "groceries").available, 30000); // not €500 yet
    assert.equal(before.unassigned, 160000);
    assert.equal(category(computeBudgetMonth(input, "2026-12").categories, "groceries").available, 30000, "nor in a later month");

    const onTheDay = computeBudgetMonth({ ...input, today: "2026-11-28" }, "2026-11");
    assert.equal(category(onTheDay.categories, "groceries").available, 50000);
    assert.equal(onTheDay.unassigned, 160000);
  });

  it("splits of one receipt dated after today: the spending counts at once, the positive split from its date (#668)", () => {
    // −€100 at the store on the 25th: €150 of groceries, €50 back on a household return.
    const input: BudgetInput = {
      categoryIds: ["groceries", "household"],
      income: [{ month: "2026-11", date: "2026-11-05", amount: 200000 }],
      assignments: [
        { categoryId: "groceries", month: "2026-11", amount: 30000 },
        { categoryId: "household", month: "2026-11", amount: 10000 },
      ],
      activity: [
        { categoryId: "groceries", month: "2026-11", date: "2026-11-25", amount: -15000 },
        { categoryId: "household", month: "2026-11", date: "2026-11-25", amount: 5000 },
      ],
      today: "2026-11-21",
    };

    const before = computeBudgetMonth(input, "2026-11");
    assert.equal(category(before.categories, "groceries").available, 15000);
    assert.equal(category(before.categories, "household").available, 10000);

    const onTheDay = computeBudgetMonth({ ...input, today: "2026-11-25" }, "2026-11");
    assert.equal(category(onTheDay.categories, "groceries").available, 15000);
    assert.equal(category(onTheDay.categories, "household").available, 15000);
  });

  it("a card refund dated after today moves nothing between the category and the payment category until its date (#668)", () => {
    const base: BudgetInput = {
      categoryIds: ["groceries"],
      paymentCategoryIds: ["visa-payment"],
      income: [{ month: "2026-11", date: "2026-11-05", amount: 200000 }],
      assignments: [{ categoryId: "groceries", month: "2026-11", amount: 30000 }],
      activity: [{ categoryId: "groceries", month: "2026-11", date: "2026-11-10", amount: -10000, paymentCategoryId: "visa-payment" }],
      today: "2026-11-21",
    };
    const withRefund: BudgetInput = {
      ...base,
      activity: [
        ...base.activity,
        { categoryId: "groceries", month: "2026-11", date: "2026-11-28", amount: 4000, paymentCategoryId: "visa-payment" },
      ],
    };

    assert.deepEqual(computeBudgetMonth(withRefund, "2026-11"), computeBudgetMonth(base, "2026-11"));
    const onTheDay = computeBudgetMonth({ ...withRefund, today: "2026-11-28" }, "2026-11");
    assert.equal(category(onTheDay.categories, "groceries").available, 24000);
    assert.notDeepEqual(onTheDay.paymentCategories, computeBudgetMonth({ ...base, today: "2026-11-28" }, "2026-11").paymentCategories);
  });

  it("a cash refund dated after today changes how the month closes, and the next month, only from its date (#668)", () => {
    const input: BudgetInput = {
      categoryIds: ["groceries"],
      income: [{ month: "2026-11", date: "2026-11-02", amount: 200000 }],
      assignments: [{ categoryId: "groceries", month: "2026-11", amount: 5000 }],
      activity: [
        { categoryId: "groceries", month: "2026-11", date: "2026-11-10", amount: -10000 },
        { categoryId: "groceries", month: "2026-11", date: "2026-11-28", amount: 6000 },
      ],
      today: "2026-11-21",
    };

    assert.equal(category(computeBudgetMonth(input, "2026-11").categories, "groceries").available, -5000);
    const december = computeBudgetMonth(input, "2026-12");
    assert.equal(december.overspentLastMonth, 5000);
    assert.equal(december.unassigned, 190000);
    assert.equal(category(december.categories, "groceries").available, 0);

    const later = { ...input, today: "2026-11-28" };
    assert.equal(category(computeBudgetMonth(later, "2026-11").categories, "groceries").available, 1000);
    const decemberLater = computeBudgetMonth(later, "2026-12");
    assert.equal(decemberLater.overspentLastMonth, 0);
    assert.equal(decemberLater.unassigned, 195000);
    assert.equal(category(decemberLater.categories, "groceries").available, 1000);
  });

  it("a card refund dated after today: the payment category holds more than the debt until its date (#668)", () => {
    const input: BudgetInput = {
      categoryIds: ["groceries"],
      paymentCategoryIds: ["visa-payment"],
      income: [{ month: "2026-11", date: "2026-11-02", amount: 200000 }],
      assignments: [{ categoryId: "groceries", month: "2026-11", amount: 5000 }],
      activity: [
        { categoryId: "groceries", month: "2026-11", date: "2026-11-10", amount: -8000, paymentCategoryId: "visa-payment" },
        { categoryId: "groceries", month: "2026-11", date: "2026-11-28", amount: 3000, paymentCategoryId: "visa-payment" },
      ],
      // The card's real debt counts every transaction to the end of the month, the refund included.
      cardBalances: [{ paymentCategoryId: "visa-payment", transactions: owing(5000, "2026-11-28") }],
      today: "2026-11-21",
    };

    const before = computeBudgetMonth(input, "2026-11");
    assert.equal(before.creditOverspending, 3000);
    assert.equal(category(before.paymentCategories, "visa-payment").available, 5000);
    assert.equal(category(before.paymentCategories, "visa-payment").uncovered, 0);

    const onTheDay = computeBudgetMonth({ ...input, today: "2026-11-28" }, "2026-11");
    assert.equal(onTheDay.creditOverspending, 0);
    assert.equal(category(onTheDay.categories, "groceries").available, 0);
    assert.equal(category(onTheDay.paymentCategories, "visa-payment").available, 5000);
  });

  it("an undated refund counts from the first day of its month (#668)", () => {
    const input: BudgetInput = {
      categoryIds: ["groceries"],
      income: [],
      assignments: [],
      activity: [{ categoryId: "groceries", month: "2026-12", amount: 5000 }],
      today: "2026-11-30",
    };
    assert.equal(category(computeBudgetMonth(input, "2026-12").categories, "groceries").available, 0);
    assert.equal(category(computeBudgetMonth({ ...input, today: "2026-12-01" }, "2026-12").categories, "groceries").available, 5000);
  });

  it("assigning more than is available takes unassigned money below zero", () => {
    const input: BudgetInput = {
      today: TODAY,
      categoryIds: ["groceries"],
      income: [{ month: "2026-09", amount: 10000 }],
      assignments: [{ categoryId: "groceries", month: "2026-09", amount: 15000 }],
      activity: [],
    };

    assert.equal(computeBudgetMonth(input, "2026-09").unassigned, -5000);
  });

  describe("card B pays card A's debt: money follows the debt (rule 8, #732)", () => {
    /**
     * Card A owes `owedBefore` and its payment category holds `holds`; card B, with nothing set
     * aside and no debt, pays `paid` of A's debt on 15 September (B is charged, A is paid).
     */
    function payDown(owedBefore: number, holds: number, paid: number) {
      const input: BudgetInput = {
        ...EMPTY,
        paymentCategoryIds: ["a-payment", "b-payment"],
        assignments: [{ categoryId: "a-payment", month: "2026-09", amount: holds }],
        cardBalances: [
          { paymentCategoryId: "a-payment", transactions: [...owing(owedBefore, "2026-09-01"), { date: "2026-09-15", amount: paid }] },
          { paymentCategoryId: "b-payment", transactions: [{ date: "2026-09-15", amount: -paid }] },
        ],
        cardTransfers: [
          { paidPaymentCategoryId: "a-payment", chargedPaymentCategoryId: "b-payment", month: "2026-09", date: "2026-09-15", id: "t1", amount: paid },
        ],
      };
      const result = computeBudgetMonth(input, "2026-09");
      return { a: category(result.paymentCategories, "a-payment"), b: category(result.paymentCategories, "b-payment") };
    }

    it("A owes €500 and holds €500, B pays €500: €500 moves, B has nothing to cover", () => {
      const { a, b } = payDown(50000, 50000, 50000);
      assert.equal(a.available, 0);
      assert.equal(a.activity, -50000);
      assert.equal(b.available, 50000);
      assert.equal(b.owed, 50000);
      assert.equal(b.uncovered, 0);
    });

    it("A owes €500 and holds €300, B pays €500: €300 moves, B has €200 to cover", () => {
      const { a, b } = payDown(50000, 30000, 50000);
      assert.equal(a.available, 0);
      assert.equal(a.uncovered, 0);
      assert.equal(b.available, 30000);
      assert.equal(b.uncovered, 20000);
      assert.equal(b.cashOverspending, 0, "the part that does not move is never cash overspending");
    });

    it("A owes €800 and holds €300, B pays €500: nothing moves, B has €500 to cover", () => {
      const { a, b } = payDown(80000, 30000, 50000);
      assert.equal(a.available, 30000);
      assert.equal(a.owed, 30000);
      assert.equal(a.uncovered, 0);
      assert.equal(b.available, 0);
      assert.equal(b.uncovered, 50000);
    });

    it("A owes €800 and holds €900, B pays €500: €500 moves, A keeps €400", () => {
      const { a, b } = payDown(80000, 90000, 50000);
      assert.equal(a.available, 40000);
      assert.equal(a.owed, 30000);
      assert.equal(b.available, 50000);
      assert.equal(b.uncovered, 0);
    });

    it("A owes €500 and holds €500, B pays €600: A is €100 in credit, €600 moves, A's −€100 is its credit, not cash overspending", () => {
      const { a, b } = payDown(50000, 50000, 60000);
      assert.equal(a.owed, -10000);
      assert.equal(a.available, -10000);
      assert.equal(a.cashOverspending, 0);
      assert.equal(b.available, 60000);
      assert.equal(b.uncovered, 0);
    });

    it("money assigned to B, the card that was charged, stays on B: one assignment settles it", () => {
      const before = payDown(50000, 30000, 50000).b;
      const input: BudgetInput = {
        ...EMPTY,
        paymentCategoryIds: ["a-payment", "b-payment"],
        assignments: [
          { categoryId: "a-payment", month: "2026-09", amount: 30000 },
          { categoryId: "b-payment", month: "2026-09", amount: before.uncovered },
        ],
        cardBalances: [
          { paymentCategoryId: "a-payment", transactions: [...owing(50000, "2026-09-01"), { date: "2026-09-15", amount: 50000 }] },
          { paymentCategoryId: "b-payment", transactions: [{ date: "2026-09-15", amount: -50000 }] },
        ],
        cardTransfers: [
          { paidPaymentCategoryId: "a-payment", chargedPaymentCategoryId: "b-payment", month: "2026-09", date: "2026-09-15", id: "t1", amount: 50000 },
        ],
      };
      const b = category(computeBudgetMonth(input, "2026-09").paymentCategories, "b-payment");
      assert.equal(b.available, 50000);
      assert.equal(b.uncovered, 0);
    });

    it("a card whose balance is not given moves only what its payment category holds", () => {
      const input: BudgetInput = {
        ...EMPTY,
        paymentCategoryIds: ["a-payment", "b-payment"],
        assignments: [{ categoryId: "a-payment", month: "2026-09", amount: 30000 }],
        cardTransfers: [
          { paidPaymentCategoryId: "a-payment", chargedPaymentCategoryId: "b-payment", month: "2026-09", date: "2026-09-15", id: "t1", amount: 50000 },
        ],
      };
      const result = computeBudgetMonth(input, "2026-09");
      assert.equal(category(result.paymentCategories, "a-payment").available, 0);
      assert.equal(category(result.paymentCategories, "a-payment").cashOverspending, 0);
      assert.equal(category(result.paymentCategories, "b-payment").available, 30000);
    });

    it("applies a month's transfers in date order, then id, whatever order they are given in", () => {
      // A owes €1,000 and holds €600; B pays €500 of it on the 10th, C €500 on the 20th, then
      // nothing is owed on A. B's transfer comes first and gets €500, C's the €100 left.
      const transfers = [
        { paidPaymentCategoryId: "a-payment", chargedPaymentCategoryId: "c-payment", month: "2026-09", date: "2026-09-20", id: "t0", amount: 50000 },
        { paidPaymentCategoryId: "a-payment", chargedPaymentCategoryId: "b-payment", month: "2026-09", date: "2026-09-10", id: "t9", amount: 50000 },
      ] as const;
      const base: BudgetInput = {
        ...EMPTY,
        paymentCategoryIds: ["a-payment", "b-payment", "c-payment"],
        assignments: [{ categoryId: "a-payment", month: "2026-09", amount: 60000 }],
        cardBalances: [{ paymentCategoryId: "a-payment", transactions: [...owing(100000, "2026-09-01"), { date: "2026-09-10", amount: 50000 }, { date: "2026-09-20", amount: 50000 }] }],
      };
      for (const cardTransfers of [[...transfers], [...transfers].reverse()]) {
        const result = computeBudgetMonth({ ...base, cardTransfers }, "2026-09");
        assert.equal(category(result.paymentCategories, "b-payment").available, 50000);
        assert.equal(category(result.paymentCategories, "c-payment").available, 10000);
        assert.equal(category(result.paymentCategories, "a-payment").available, 0);
      }
      // The same day: the id decides.
      const sameDay = transfers.map((t) => ({ ...t, date: "2026-09-10" }));
      const result = computeBudgetMonth({ ...base, cardTransfers: sameDay }, "2026-09");
      assert.equal(category(result.paymentCategories, "c-payment").available, 50000);
      assert.equal(category(result.paymentCategories, "b-payment").available, 10000);
    });

    it("refuses a transfer dated outside its month", () => {
      assert.throws(
        () =>
          computeBudgetMonth(
            {
              ...EMPTY,
              paymentCategoryIds: ["a-payment", "b-payment"],
              cardTransfers: [
                { paidPaymentCategoryId: "a-payment", chargedPaymentCategoryId: "b-payment", month: "2026-09", date: "2026-10-01", id: "t1", amount: 100 },
              ],
            },
            "2026-09",
          ),
        (error) => isValidationError(error, "invalid_date"),
      );
    });
  });

  it("rejects invalid data with a translatable error code", () => {
    assert.throws(
      () => computeBudgetMonth(EMPTY, "2026-13"),
      (error) => isValidationError(error, "invalid_month"),
    );
    assert.throws(
      () => computeBudgetMonth({ ...EMPTY, categoryIds: ["a", "a"] }, "2026-09"),
      (error) => isValidationError(error, "duplicate_category"),
    );
    assert.throws(
      () =>
        computeBudgetMonth(
          { ...EMPTY, assignments: [{ categoryId: "missing", month: "2026-09", amount: 100 }] },
          "2026-09",
        ),
      (error) => isValidationError(error, "unknown_category") && error.details["categoryId"] === "missing",
    );
    assert.throws(
      () => computeBudgetMonth({ ...EMPTY, income: [{ month: "2026-09", amount: 10.5 }] }, "2026-09"),
      (error) => isValidationError(error, "invalid_amount"),
    );
    assert.throws(
      () =>
        computeBudgetMonth(
          {
            ...EMPTY,
            paymentCategoryIds: ["a-payment"],
            cardTransfers: [
              { paidPaymentCategoryId: "missing", chargedPaymentCategoryId: "a-payment", month: "2026-09", date: "2026-09-01", id: "t1", amount: 100 },
            ],
          },
          "2026-09",
        ),
      (error) => isValidationError(error, "unknown_category") && error.details["categoryId"] === "missing",
    );
    assert.throws(
      () =>
        computeBudgetMonth(
          {
            ...EMPTY,
            paymentCategoryIds: ["a-payment", "b-payment"],
            cardTransfers: [
              { paidPaymentCategoryId: "a-payment", chargedPaymentCategoryId: "b-payment", month: "2026-09", date: "2026-09-01", id: "t1", amount: 0 },
            ],
          },
          "2026-09",
        ),
      (error) => isValidationError(error, "invalid_amount"),
    );
    assert.throws(
      () => computeBudgetMonth({ ...EMPTY, income: [{ month: "2026-09", date: "2026-10-01", amount: 100 }] }, "2026-09"),
      (error) => isValidationError(error, "invalid_date"),
    );
    assert.throws(
      () =>
        computeBudgetMonth(
          { ...EMPTY, categoryIds: ["groceries"], activity: [{ categoryId: "groceries", month: "2026-09", date: "2026-10-01", amount: 100 }] },
          "2026-09",
        ),
      (error) => isValidationError(error, "invalid_date"),
    );
    assert.throws(
      () => computeBudgetMonth({ ...EMPTY, today: "2026-02-30" }, "2026-09"),
      (error) => isValidationError(error, "invalid_date"),
    );
  });
});

/**
 * A random budget over six months, with income on random days and a random today: inside the
 * months most of the time, so that some income is not received yet. One income in five is
 * negative (#782: money going out of Unassigned, such as an overdraft recorded there).
 */
function randomBudget(random: () => number): { input: BudgetInput; month: string; today: string } {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
  const categoryIds = ["groceries", "rent", "fun", "car"];
  const amount = () => Math.floor(random() * 200000) - 50000; // from −€500 to +€1,500
  const day = () => String(Math.floor(random() * 28) + 1).padStart(2, "0");
  const today = random() < 0.25 ? "2026-12-31" : `${pick(months)}-${day()}`;
  const input: BudgetInput = {
    categoryIds,
    income: Array.from({ length: 5 }, () => {
      const month = pick(months);
      return { month, date: `${month}-${day()}`, amount: random() < 0.2 ? -Math.abs(amount()) : Math.abs(amount()) };
    }),
    assignments: Array.from({ length: 15 }, () => ({ categoryId: pick(categoryIds), month: pick(months), amount: amount() })),
    // Mostly spending, with a refund now and then (#668); dated on a random day, or undated.
    activity: Array.from({ length: 20 }, () => {
      const month = pick(months);
      const value = random() < 0.25 ? Math.abs(amount()) : -Math.abs(amount());
      return random() < 0.8
        ? { categoryId: pick(categoryIds), month, date: `${month}-${day()}`, amount: value }
        : { categoryId: pick(categoryIds), month, amount: value };
    }),
    today,
  };
  return { input, month: pick(months), today };
}

/** Income received by the end of `month` and by today: what the books hold at the end of `month`. */
function receivedBy(input: BudgetInput, month: string, today: string): number {
  return input.income.filter((i) => i.month <= month && (i.date ?? `${i.month}-01`) <= today).reduce((sum, i) => sum + i.amount, 0);
}

/**
 * Activity up to the end of `month`, less every refund dated after today (#668): money coming in
 * that has not arrived yet.
 */
function activityBy(input: BudgetInput, month: string, today: string): number {
  return input.activity
    .filter((a) => a.month <= month && (a.amount <= 0 || (a.date ?? `${a.month}-01`) <= today))
    .reduce((sum, a) => sum + a.amount, 0);
}

describe("budget invariant", () => {
  // Whatever happens, the books must balance:
  //   unassigned money + available of the month + assigned in future
  //   = income received by the end of the month (and by today) + activity up to the end of the
  //     month, less the refunds dated after today (that is, the money in the accounts at the end
  //     of the month, less every positive split not received yet: #668)
  it("balances on 500 random budgets", () => {
    const random = mulberry32(42);
    for (let run = 0; run < 500; run++) {
      const { input, month, today } = randomBudget(random);

      const result = computeBudgetMonth(input, month);

      const availableTotal = result.categories.reduce((sum, c) => sum + c.available, 0);
      assert.equal(
        result.unassigned + availableTotal + result.assignedInFuture,
        receivedBy(input, month, today) + activityBy(input, month, today),
        `invariant violated on run ${run}, month ${month}`,
      );
    }
  });
});

describe("unassigned money properties (#650)", () => {
  /**
   * cum(N) of rule 1, for every month N from `month` to the last one of the data: a month after
   * `month` counts only its positive income (#782).
   */
  function cumulative(input: BudgetInput, month: string, today: string, overspentBefore: number): number[] {
    const last = [month, ...input.income.map((i) => i.month), ...input.assignments.map((a) => a.month), ...input.activity.map((a) => a.month)].reduce(
      (latest, m) => (m > latest ? m : latest),
    );
    const values: number[] = [];
    for (let m = month; m <= last; m = shiftMonth(m, 1)) {
      const assigned = input.assignments.filter((a) => a.month <= m).reduce((sum, a) => sum + a.amount, 0);
      const laterNegative = input.income
        .filter((i) => i.month > month && i.month <= m && i.amount < 0 && (i.date ?? `${i.month}-01`) <= today)
        .reduce((sum, i) => sum + i.amount, 0);
      values.push(receivedBy(input, m, today) - laterNegative - assigned - overspentBefore);
    }
    return values;
  }

  /** Cash overspending of the months before `month`, as the function itself closed them. */
  function overspentBefore(input: BudgetInput, month: string): number {
    let total = 0;
    for (const m of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].filter((m) => m < month)) {
      total += computeBudgetMonth(input, shiftMonth(m, 1)).overspentLastMonth;
    }
    return total;
  }

  it("unassigned money is the smallest cum(N) from the month on, and assigned in future what the month itself pays", () => {
    const random = mulberry32(650);
    for (let run = 0; run < 300; run++) {
      const { input, month, today } = randomBudget(random);
      const result = computeBudgetMonth(input, month);
      const values = cumulative(input, month, today, overspentBefore(input, month));

      assert.equal(result.unassigned, Math.min(...values), `run ${run}, month ${month}`);
      assert.equal(result.assignedInFuture, (values[0] as number) - result.unassigned, `run ${run}, month ${month}`);
      assert.ok(result.assignedInFuture >= 0, `run ${run}, month ${month}`);
    }
  });

  it("income dated after a month never shows in it, and changes it only when a later month is over-assigned", () => {
    const random = mulberry32(6500);
    for (let run = 0; run < 300; run++) {
      const { input, month, today } = randomBudget(random);
      // More income, dated after the month and already received.
      const later = shiftMonth(month, 1 + Math.floor(random() * 3));
      const more: BudgetInput = {
        ...input,
        income: [...input.income, { month: later, date: `${later}-01`, amount: Math.floor(random() * 500000) + 1 }],
        today: "2026-12-31",
      };
      const before = computeBudgetMonth({ ...input, today: "2026-12-31" }, month);
      const after = computeBudgetMonth(more, month);

      // Every available is the same whatever income there is (on the same today: a refund dated
      // after today changes a category on its date, #668).
      assert.deepEqual(after.categories, before.categories, `run ${run}, month ${month}`);
      // Never more than the month itself has received (cum(M) holds no income after M).
      const values = cumulative(more, month, "2026-12-31", overspentBefore({ ...input, today: "2026-12-31" }, month));
      assert.ok(after.unassigned <= (values[0] as number), `run ${run}, month ${month}`);
      assert.ok(after.unassigned >= before.unassigned, `run ${run}, month ${month}`);
      // No later month over-assigned: cum(N) never drops below cum(M), so the month shows cum(M).
      const beforeValues = cumulative(input, month, "2026-12-31", overspentBefore({ ...input, today: "2026-12-31" }, month));
      if (beforeValues.every((v) => v >= (beforeValues[0] as number))) {
        assert.equal(after.unassigned, before.unassigned, `run ${run}, month ${month}`);
      }
    }
  });
});

describe("totals beyond the safe range (#651)", () => {
  it("answers amount_total_overflow naming the input that tipped it, not invalid_amount on unassigned", () => {
    assert.throws(
      () =>
        computeBudgetMonth(
          {
            ...EMPTY,
            categoryIds: ["rent"],
            income: [{ month: "2026-09", amount: Number.MAX_SAFE_INTEGER }],
            assignments: [{ categoryId: "rent", month: "2026-10", amount: -Number.MAX_SAFE_INTEGER }],
          },
          "2026-09",
        ),
      (error) =>
        isValidationError(error, "amount_total_overflow") &&
        error.details.label === "assignment" &&
        error.details.categoryId === "rent" &&
        error.details.month === "2026-10",
    );
  });

  it("still computes a month whose figures go above the per-amount cap", () => {
    const cap = MAX_AMOUNT_CENTS;
    const result = computeBudgetMonth(
      {
        ...EMPTY,
        categoryIds: ["rent"],
        income: [
          { month: "2026-09", amount: cap },
          { month: "2026-09", amount: cap },
        ],
        assignments: [{ categoryId: "rent", month: "2026-09", amount: cap / 2 }],
      },
      "2026-09",
    );
    assert.equal(result.unassigned, 2 * cap - cap / 2);
  });
});
