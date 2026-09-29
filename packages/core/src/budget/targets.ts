/**
 * Target calculation (design.md, "Target calculation"). A target tells the
 * budget how much a category asks for in the current month. There are four
 * kinds. *carried* is the available balance brought over from the previous
 * month, *assigned* is what the user assigned this month and *available* is
 * the category's balance now.
 *
 * Pure, no database: given a target and a category's current numbers, each
 * kind returns what it asks this month, what is still missing, and progress
 * (a 0..1 fraction; the UI formats and rounds it for display).
 *
 * Payment categories of credit cards never have targets (design.md) — that
 * rule belongs to whoever assembles a category's target, not to this module.
 */

import type { Cents } from "../money.ts";
import { assertCents } from "../money.ts";
import type { Month } from "../month.ts";
import { assertMonth, compareMonths, monthRange, nextMonth } from "../month.ts";

/** Every N months a repeating expense is due, design.md's own fixed choices. */
export type RepeatInterval = 2 | 3 | 4 | 6 | 12 | 24;

export interface MonthlyTarget {
  readonly kind: "monthly";
  readonly amount: Cents;
}

export interface ByDateTarget {
  readonly kind: "by_date";
  readonly amount: Cents;
  readonly dueMonth: Month;
}

export interface RepeatingTarget {
  readonly kind: "repeating";
  readonly amount: Cents;
  readonly every: RepeatInterval;
  /** The next due month; once it is in the past, the calculation rolls it forward by `every`. */
  readonly dueMonth: Month;
}

export interface BalanceTarget {
  readonly kind: "balance";
  readonly threshold: Cents;
}

export type Target = MonthlyTarget | ByDateTarget | RepeatingTarget | BalanceTarget;

export interface TargetProgress {
  /** What the target asks for this month. */
  readonly asks: Cents;
  /** Still missing this month, at least 0. */
  readonly missing: Cents;
  /** 0..1 fraction; not clamped, so a target already exceeded reads above 1. */
  readonly progress: number;
}

export interface CategoryTargetState {
  readonly carried: Cents;
  readonly assigned: Cents;
  readonly available: Cents;
}

/** Adds `count` months to a month, wrapping the year — `nextMonth` applied `count` times. */
function addMonths(month: Month, count: number): Month {
  let result = month;
  for (let i = 0; i < count; i++) {
    result = nextMonth(result);
  }
  return result;
}

/** Rolls `dueMonth` forward by `every` until it is no longer in the past relative to `currentMonth`. */
function effectiveDueMonth(dueMonth: Month, every: RepeatInterval, currentMonth: Month): Month {
  let due = dueMonth;
  while (compareMonths(due, currentMonth) < 0) {
    due = addMonths(due, every);
  }
  return due;
}

/** "Amount by a date" and "repeating expense" share this: save up `amount` by `dueMonth`. */
function planByDate(amount: Cents, dueMonth: Month, state: CategoryTargetState, currentMonth: Month): TargetProgress {
  assertMonth(dueMonth);
  // "Months left" counts the current month and the due month (design.md); at least 1,
  // so an overdue due month still asks for the rest in one go instead of dividing by zero.
  const monthsLeft = Math.max(1, monthRange(currentMonth, dueMonth).length);
  const asks = Math.max(0, Math.ceil((amount - state.carried) / monthsLeft));
  const missing = Math.max(0, asks - state.assigned);
  const progress = state.available / amount;
  return { asks, missing, progress };
}

/**
 * @throws ValidationError (via `assertMonth`/`assertCents`) for an invalid month or amount.
 */
export function computeTarget(target: Target, state: CategoryTargetState, currentMonth: Month): TargetProgress {
  assertMonth(currentMonth);
  assertCents(state.carried, "carried");
  assertCents(state.assigned, "assigned");
  assertCents(state.available, "available");

  switch (target.kind) {
    case "monthly": {
      assertCents(target.amount, "amount");
      const asks = target.amount;
      const missing = Math.max(0, asks - state.assigned);
      const progress = state.assigned / target.amount;
      return { asks, missing, progress };
    }
    case "by_date": {
      assertCents(target.amount, "amount");
      return planByDate(target.amount, target.dueMonth, state, currentMonth);
    }
    case "repeating": {
      assertCents(target.amount, "amount");
      const dueMonth = effectiveDueMonth(target.dueMonth, target.every, currentMonth);
      return planByDate(target.amount, dueMonth, state, currentMonth);
    }
    case "balance": {
      assertCents(target.threshold, "threshold");
      const asks = Math.max(0, target.threshold - state.available);
      return { asks, missing: asks, progress: state.available / target.threshold };
    }
  }
}
