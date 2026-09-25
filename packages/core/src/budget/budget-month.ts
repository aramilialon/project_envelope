/**
 * Computes one month of an envelope budget.
 *
 * Given the lists of income, assignments and activity, it computes for a month:
 * - "ready to assign": money that has come in but has no job yet;
 * - for every category: assigned, activity of the month and available.
 *
 * Rules:
 * 1. Only money that has already come in can be assigned: income dated in
 *    future months does not count.
 * 2. A category's positive available balance rolls over to the next month.
 * 3. A category that is overspent at the end of a month starts the next
 *    month at zero, and the uncovered amount is taken from "ready to assign".
 * 4. Money assigned to future months already has a job: it reduces
 *    "ready to assign" immediately.
 *
 * Limitation of this first version: all spending is treated as cash or debit.
 * Credit cards, where uncovered spending becomes debt on the card, come later.
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

/** Money that came into "ready to assign" in a month (salary, starting balance…). */
export interface Income {
  readonly month: Month;
  readonly amount: Cents;
}

/** Money assigned to a category for a month. Negative = money taken out. */
export interface Assignment {
  readonly categoryId: string;
  readonly month: Month;
  readonly amount: Cents;
}

/** Total activity of a category in a month: spending is negative, refunds positive. */
export interface Activity {
  readonly categoryId: string;
  readonly month: Month;
  readonly amount: Cents;
}

export interface BudgetInput {
  readonly categoryIds: readonly string[];
  readonly income: readonly Income[];
  readonly assignments: readonly Assignment[];
  readonly activity: readonly Activity[];
}

export interface CategoryMonth {
  readonly categoryId: string;
  /** Available balance carried over from the previous month (never negative). */
  readonly carriedOver: Cents;
  readonly assigned: Cents;
  readonly activity: Cents;
  /** carriedOver + assigned + activity. Negative = overspent. */
  readonly available: Cents;
}

export interface BudgetMonth {
  readonly month: Month;
  readonly readyToAssign: Cents;
  /** Money already assigned to months after this one. */
  readonly assignedInFuture: Cents;
  /** Overspending of the previous month, taken from "ready to assign" in this month. */
  readonly overspentLastMonth: Cents;
  readonly categories: readonly CategoryMonth[];
}

/** Key for "category + month" maps. */
function key(categoryId: string, month: Month): string {
  return `${categoryId}|${month}`;
}

/** Adds `amount` to the value at `mapKey`, starting from zero. Like `$h{$k} += $v` in Perl. */
function addTo(map: Map<string, Cents>, mapKey: string, amount: Cents): void {
  map.set(mapKey, (map.get(mapKey) ?? 0) + amount);
}

function validate(input: BudgetInput, month: Month): void {
  assertMonth(month);
  const known = new Set<string>();
  for (const id of input.categoryIds) {
    if (known.has(id)) {
      throw new ValidationError("duplicate_category", `duplicate category: "${id}"`, { categoryId: id });
    }
    known.add(id);
  }
  for (const item of input.income) {
    assertMonth(item.month);
    assertCents(item.amount, "income");
  }
  for (const item of [...input.assignments, ...input.activity]) {
    assertMonth(item.month);
    assertCents(item.amount);
    if (!known.has(item.categoryId)) {
      throw new ValidationError("unknown_category", `unknown category: "${item.categoryId}"`, {
        categoryId: item.categoryId,
      });
    }
  }
}

/**
 * Computes the state of the budget in the given month.
 *
 * @throws ValidationError if the data contains invalid months, amounts or categories.
 */
export function computeBudgetMonth(input: BudgetInput, month: Month): BudgetMonth {
  validate(input, month);

  // 1. Group assignments and activity by category and month.
  const assignedBy = new Map<string, Cents>();
  const activityBy = new Map<string, Cents>();
  for (const a of input.assignments) addTo(assignedBy, key(a.categoryId, a.month), a.amount);
  for (const a of input.activity) addTo(activityBy, key(a.categoryId, a.month), a.amount);

  // 2. Find the first month with data: the computation starts there.
  let firstMonth = month;
  for (const item of [...input.income, ...input.assignments, ...input.activity]) {
    if (compareMonths(item.month, firstMonth) < 0) firstMonth = item.month;
  }

  // 3. Walk the months before the requested one, carrying balances over.
  const carried = new Map<string, Cents>(input.categoryIds.map((id): [string, Cents] => [id, 0]));
  let overspentTotal = 0;
  let overspentLastMonth = 0;
  const previousMonths = monthRange(firstMonth, month).slice(0, -1);

  for (const m of previousMonths) {
    let overspentThisMonth = 0;
    for (const id of input.categoryIds) {
      const available =
        (carried.get(id) ?? 0) + (assignedBy.get(key(id, m)) ?? 0) + (activityBy.get(key(id, m)) ?? 0);
      if (available < 0) {
        // Rule 3: the category restarts at zero, the overspending weighs on "ready to assign".
        overspentThisMonth += -available;
        carried.set(id, 0);
      } else {
        carried.set(id, available);
      }
    }
    overspentTotal += overspentThisMonth;
    overspentLastMonth = overspentThisMonth;
  }

  // 4. Compute the categories in the requested month.
  const categories: CategoryMonth[] = input.categoryIds.map((id) => {
    const carriedOver = carried.get(id) ?? 0;
    const assigned = assignedBy.get(key(id, month)) ?? 0;
    const activity = activityBy.get(key(id, month)) ?? 0;
    return { categoryId: id, carriedOver, assigned, activity, available: carriedOver + assigned + activity };
  });

  // 5. Ready to assign = income so far − everything assigned (future too) − past overspending.
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

  const readyToAssign = incomeSoFar - assignedTotal - overspentTotal;
  assertCents(readyToAssign, "ready to assign");

  return { month, readyToAssign, assignedInFuture, overspentLastMonth, categories };
}
