/**
 * Computes one month of an envelope budget.
 *
 * Given the lists of income, assignments, activity and credit card payments,
 * it computes for a month:
 * - unassigned money: money that has come in but is not assigned yet;
 * - for every category: assigned, activity of the month and available;
 * - for every credit card: its payment category, which holds the money set
 *   aside to pay the card.
 *
 * Rules:
 * 1. Only money that has already come in can be assigned: income dated in
 *    future months does not count.
 * 2. A category's positive available balance rolls over to the next month.
 * 3. Money assigned to future months is already assigned: it reduces
 *    unassigned money immediately.
 * 4. Spending on a credit card, as far as the category covers it, moves the
 *    same amount from the category to the card's payment category: the money
 *    is set aside to pay the card. A refund on the card moves it back.
 * 5. A card payment (a transfer from a cash account to the card) is spending
 *    of the payment category.
 * 6. A category still negative at the end of a month starts the next month at
 *    zero. The overspending is split in two:
 *    - credit overspending: the part paid with a credit card. It is new debt
 *      on the card, not covered by the payment category, and does NOT touch
 *      unassigned money;
 *    - cash overspending: the rest. That money has already left an account,
 *      so it is taken from unassigned money the following month.
 *    The overspending is attributed to credit card spending first, up to the
 *    amount spent with cards in that category and month.
 *
 * Coverage is decided on the month's final numbers: assigning more money to a
 * category later in the month also funds the credit card spending made
 * earlier, exactly as if the money had been there from the start.
 *
 * The function is "pure": it reads no database or network, receives
 * everything as parameters and returns a result. That makes it easy to test,
 * and it runs the same on the server, in the browser and on the phone.
 */

import { ValidationError } from "../errors.ts";
import type { Cents } from "../money.ts";
import { assertCents } from "../money.ts";
import type { Month } from "../month.ts";
import { assertMonth, compareMonths, monthRange } from "../month.ts";

/** Money that came into unassigned money in a month (salary, starting balance…). */
export interface Income {
  readonly month: Month;
  readonly amount: Cents;
}

/** Money assigned to a category (or to a payment category) for a month. Negative = money taken out. */
export interface Assignment {
  readonly categoryId: string;
  readonly month: Month;
  readonly amount: Cents;
}

/**
 * Activity of a category in a month: spending is negative, refunds positive.
 * When the money moved on a credit card, `paymentCategoryId` names that card's
 * payment category; otherwise the activity was on a cash account.
 */
export interface Activity {
  readonly categoryId: string;
  readonly month: Month;
  readonly amount: Cents;
  readonly paymentCategoryId?: string;
}

/** Money paid to a credit card in a month. Positive = payment; negative = cash taken from the card. */
export interface CardPayment {
  readonly paymentCategoryId: string;
  readonly month: Month;
  readonly amount: Cents;
}

export interface BudgetInput {
  /** Regular categories. */
  readonly categoryIds: readonly string[];
  /** One payment category for each on-budget credit card. */
  readonly paymentCategoryIds?: readonly string[];
  readonly income: readonly Income[];
  readonly assignments: readonly Assignment[];
  readonly activity: readonly Activity[];
  readonly cardPayments?: readonly CardPayment[];
}

export interface CategoryMonth {
  readonly categoryId: string;
  /** Available balance carried over from the previous month (never negative). */
  readonly carriedOver: Cents;
  readonly assigned: Cents;
  /**
   * Regular category: its spending and refunds.
   * Payment category: money moved in from covered card spending, minus payments.
   */
  readonly activity: Cents;
  /** carriedOver + assigned + activity. Negative = overspent. */
  readonly available: Cents;
  /** Part of a negative `available` paid with credit cards (becomes card debt if left uncovered). */
  readonly creditOverspending: Cents;
  /** Rest of a negative `available` (taken from unassigned money next month if left uncovered). */
  readonly cashOverspending: Cents;
}

export interface BudgetMonth {
  readonly month: Month;
  readonly unassigned: Cents;
  /** Money already assigned to months after this one. */
  readonly assignedInFuture: Cents;
  /** Cash overspending of the previous month, taken from unassigned money in this month. */
  readonly overspentLastMonth: Cents;
  /** Total credit overspending in this month's categories. */
  readonly creditOverspending: Cents;
  readonly categories: readonly CategoryMonth[];
  readonly paymentCategories: readonly CategoryMonth[];
}

/** Key for "category + month" maps. */
function key(id: string, month: Month): string {
  return `${id}|${month}`;
}

/** Adds `amount` to the value at `mapKey`, starting from zero. Like `$h{$k} += $v` in Perl. */
function addTo(map: Map<string, Cents>, mapKey: string, amount: Cents): void {
  map.set(mapKey, (map.get(mapKey) ?? 0) + amount);
}

function validate(input: BudgetInput, month: Month): void {
  assertMonth(month);
  const regular = new Set<string>();
  const payment = new Set<string>();
  for (const [ids, set] of [
    [input.categoryIds, regular],
    [input.paymentCategoryIds ?? [], payment],
  ] as const) {
    for (const id of ids) {
      if (regular.has(id) || payment.has(id)) {
        throw new ValidationError("duplicate_category", `duplicate category: "${id}"`, { categoryId: id });
      }
      set.add(id);
    }
  }
  const unknown = (id: string): never => {
    throw new ValidationError("unknown_category", `unknown category: "${id}"`, { categoryId: id });
  };
  for (const item of input.income) {
    assertMonth(item.month);
    assertCents(item.amount, "income");
  }
  for (const item of input.assignments) {
    assertMonth(item.month);
    assertCents(item.amount);
    if (!regular.has(item.categoryId) && !payment.has(item.categoryId)) unknown(item.categoryId);
  }
  for (const item of input.activity) {
    assertMonth(item.month);
    assertCents(item.amount);
    if (!regular.has(item.categoryId)) unknown(item.categoryId);
    if (item.paymentCategoryId !== undefined && !payment.has(item.paymentCategoryId)) unknown(item.paymentCategoryId);
  }
  for (const item of input.cardPayments ?? []) {
    assertMonth(item.month);
    assertCents(item.amount, "card payment");
    if (!payment.has(item.paymentCategoryId)) unknown(item.paymentCategoryId);
  }
}

interface MonthState {
  readonly categories: CategoryMonth[];
  readonly paymentCategories: CategoryMonth[];
}

/**
 * Computes all categories for one month, starting from the balances carried
 * over from the previous month.
 */
function computeMonth(
  input: BudgetInput,
  m: Month,
  carried: ReadonlyMap<string, Cents>,
  data: {
    assignedBy: ReadonlyMap<string, Cents>;
    activityBy: ReadonlyMap<string, Cents>;
    creditBy: ReadonlyMap<string, ReadonlyMap<string, Cents>>;
    paymentsBy: ReadonlyMap<string, Cents>;
  },
): MonthState {
  const paymentIds = input.paymentCategoryIds ?? [];
  const movedToPayment = new Map<string, Cents>(paymentIds.map((id): [string, Cents] => [id, 0]));

  const categories = input.categoryIds.map((id): CategoryMonth => {
    const carriedOver = carried.get(id) ?? 0;
    const assigned = data.assignedBy.get(key(id, m)) ?? 0;
    const activity = data.activityBy.get(key(id, m)) ?? 0;
    const available = carriedOver + assigned + activity;
    const overspent = Math.max(0, -available);

    // Net credit card activity of this category, card by card, in a stable order.
    const byCard = [...(data.creditBy.get(key(id, m)) ?? new Map<string, Cents>())].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    let cardOutflow = 0;
    for (const [paymentId, net] of byCard) {
      if (net > 0) addTo(movedToPayment, paymentId, -net); // Net refund: the money goes back to the category.
      else cardOutflow += -net;
    }

    // Rule 6: overspending is attributed to card spending first.
    const creditOverspending = Math.min(overspent, cardOutflow);
    const cashOverspending = overspent - creditOverspending;

    // Rule 4: the covered part of card spending moves to the payment categories.
    let toCover = cardOutflow - creditOverspending;
    for (const [paymentId, net] of byCard) {
      if (net >= 0 || toCover === 0) continue;
      const covered = Math.min(-net, toCover);
      addTo(movedToPayment, paymentId, covered);
      toCover -= covered;
    }

    return { categoryId: id, carriedOver, assigned, activity, available, creditOverspending, cashOverspending };
  });

  const paymentCategories = paymentIds.map((id): CategoryMonth => {
    const carriedOver = carried.get(id) ?? 0;
    const assigned = data.assignedBy.get(key(id, m)) ?? 0;
    const activity = (movedToPayment.get(id) ?? 0) - (data.paymentsBy.get(key(id, m)) ?? 0);
    const available = carriedOver + assigned + activity;
    // Paying more than the payment category holds spends cash that had no job: cash overspending.
    return {
      categoryId: id,
      carriedOver,
      assigned,
      activity,
      available,
      creditOverspending: 0,
      cashOverspending: Math.max(0, -available),
    };
  });

  return { categories, paymentCategories };
}

/**
 * Computes the state of the budget in the given month.
 *
 * @throws ValidationError if the data contains invalid months, amounts or categories.
 */
export function computeBudgetMonth(input: BudgetInput, month: Month): BudgetMonth {
  validate(input, month);

  // 1. Group the data by category and month.
  const assignedBy = new Map<string, Cents>();
  const activityBy = new Map<string, Cents>();
  const creditBy = new Map<string, Map<string, Cents>>();
  const paymentsBy = new Map<string, Cents>();
  for (const a of input.assignments) addTo(assignedBy, key(a.categoryId, a.month), a.amount);
  for (const a of input.activity) {
    addTo(activityBy, key(a.categoryId, a.month), a.amount);
    if (a.paymentCategoryId !== undefined) {
      const k = key(a.categoryId, a.month);
      const cards = creditBy.get(k) ?? new Map<string, Cents>();
      addTo(cards, a.paymentCategoryId, a.amount);
      creditBy.set(k, cards);
    }
  }
  for (const p of input.cardPayments ?? []) addTo(paymentsBy, key(p.paymentCategoryId, p.month), p.amount);
  const data = { assignedBy, activityBy, creditBy, paymentsBy };

  // 2. Find the first month with data: the computation starts there.
  let firstMonth = month;
  for (const item of [...input.income, ...input.assignments, ...input.activity, ...(input.cardPayments ?? [])]) {
    if (compareMonths(item.month, firstMonth) < 0) firstMonth = item.month;
  }

  // 3. Walk the months before the requested one, closing each of them.
  const carried = new Map<string, Cents>();
  let cashOverspentTotal = 0;
  let overspentLastMonth = 0;
  for (const m of monthRange(firstMonth, month).slice(0, -1)) {
    const state = computeMonth(input, m, carried, data);
    let cashOverspentThisMonth = 0;
    for (const c of [...state.categories, ...state.paymentCategories]) {
      // Rule 2 and rule 6: positive balances roll over, negative ones restart at zero.
      carried.set(c.categoryId, Math.max(0, c.available));
      cashOverspentThisMonth += c.cashOverspending;
    }
    cashOverspentTotal += cashOverspentThisMonth;
    overspentLastMonth = cashOverspentThisMonth;
  }

  // 4. The requested month, still open.
  const current = computeMonth(input, month, carried, data);

  // 5. Unassigned = income so far − everything assigned (future too) − past cash overspending.
  let incomeSoFar = 0;
  for (const item of input.income) {
    if (compareMonths(item.month, month) <= 0) incomeSoFar += item.amount;
  }
  let assignedTotal = 0;
  let assignedInFuture = 0;
  for (const a of input.assignments) {
    assignedTotal += a.amount;
    if (compareMonths(a.month, month) > 0) assignedInFuture += a.amount;
  }

  const unassigned = incomeSoFar - assignedTotal - cashOverspentTotal;
  assertCents(unassigned, "unassigned");

  return {
    month,
    unassigned,
    assignedInFuture,
    overspentLastMonth,
    creditOverspending: current.categories.reduce((sum, c) => sum + c.creditOverspending, 0),
    categories: current.categories,
    paymentCategories: current.paymentCategories,
  };
}
