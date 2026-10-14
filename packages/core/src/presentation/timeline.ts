import type { Cents } from "../money.ts";

/**
 * The month's own day-by-day timeline (design.md, "Timeline"; `docs/ux/mockups/budget-month.html`'s
 * own `timelineSvg`, the literal reference this mirrors): a running total of the month's own
 * events, not a per-event mark. Plain coordinates out, never rendered SVG or literal text (no
 * user-facing text in `packages/core`) — `apps/web`'s `Timeline.tsx` draws the actual `<svg>` from
 * this, formatting `TimelineCurrent.amountCents` with `Intl.NumberFormat` at render time.
 *
 * Reused as-is by the account register's own timeline (`#337`): the layout math does not care
 * whether the events are workspace-wide or one account's own, only `compact` (the account
 * register's own, smaller rendering) changes the numbers.
 *
 * Redesigned (`#390`) from the original per-event marks (a stem above/below a center axis, sized
 * by the square root of the amount) into a running total: each day's own net amount accumulates
 * into the day before it, starting at zero on day 1. A day's own segment is coloured by whether it
 * moved the total up or down — never the app's own `red`/`amber` (design.md's visual language:
 * those stay reserved for a real problem, not an ordinary day of spending) — and the current
 * value (today's own point) is called out the same way a price chart calls out its current price:
 * a dashed reference line and the amount itself, `TimelineCurrent`.
 */

export type TimelineDirection = "in" | "out";
/** `recorded`: a real transaction, counted into the solid, actual part of the line. `scheduled`/`overdue`: not yet recorded, counted into the dashed, projected part instead — an `overdue` one (its own day already past) folds into today's own point rather than its own earlier day, so the solid/dashed split stays one single vertical line. */
export type TimelineEventStatus = "recorded" | "scheduled" | "overdue";

export interface TimelineEvent {
  /** 1-based day of the month. */
  readonly day: number;
  /** Always positive — `direction` says which way it moves the running total. */
  readonly amountCents: Cents;
  readonly direction: TimelineDirection;
  readonly status: TimelineEventStatus;
}

/** Never a judgement colour (`red`/`amber` stay reserved for a real problem) — `in` the same `pen` token already used for income and "today", `out` the ordinary `ink`, `flat` a day with no net change at all. */
export type TimelineStepDirection = "in" | "out" | "flat";

export interface TimelinePoint {
  readonly day: number;
  readonly x: number;
  readonly y: number;
}

export interface TimelineSegment {
  readonly from: TimelinePoint;
  readonly to: TimelinePoint;
  readonly direction: TimelineStepDirection;
  /** `false` up to today (recorded only, solid); `true` from today on (recorded + scheduled, dashed). Every segment is `false` when `today` itself is absent — a month that is not the current one has nothing left to project. */
  readonly projected: boolean;
}

export interface TimelineCurrent {
  /** The running total through today, recorded events only — can be negative. */
  readonly amountCents: Cents;
  readonly y: number;
  /** Where the renderer draws the current-value label's own text — above the line, unless that would run past the canvas's own top edge, in which case below it instead (`#407`). */
  readonly labelY: number;
  /** Whether an overdue, not-yet-recorded item is folded into this point — a small marker, never changing the line's own colour. */
  readonly hasOverdue: boolean;
  /** Where that marker sits — the running total as if the overdue item had already been recorded. Present only when `hasOverdue` is `true`, and never the same `y` as above, or there would be nothing to mark. */
  readonly overdueY: number | undefined;
}

export interface TimelineDayTick {
  readonly day: number;
  readonly x: number;
}

export interface TimelineLayout {
  readonly width: number;
  readonly height: number;
  /** Where zero falls on the vertical scale — not necessarily the canvas's own center, since the month's own running total can sit entirely above or below it. */
  readonly zeroY: number;
  readonly axisX0: number;
  readonly axisX1: number;
  /** The "today" line's own x, and the start of the lighter "future" ground past it — absent when the month shown is not the current one. */
  readonly todayX: number | undefined;
  readonly dayTicks: readonly TimelineDayTick[];
  readonly segments: readonly TimelineSegment[];
  /** Present only when `today` is given. */
  readonly current: TimelineCurrent | undefined;
}

export interface TimelineInput {
  readonly daysInMonth: number;
  /** 1-based day of the month, only when the month being drawn is the current one. */
  readonly today: number | undefined;
  readonly events: readonly TimelineEvent[];
  /** The account register's own, smaller rendering (`#337`) — default `false`, the budget month's own. */
  readonly compact?: boolean;
}

interface Size {
  readonly width: number;
  readonly height: number;
  readonly inset: number;
  readonly padTop: number;
  readonly padBottom: number;
}

const FULL: Size = { width: 660, height: 200, inset: 20, padTop: 10, padBottom: 20 };
const COMPACT: Size = { width: 330, height: 120, inset: 12, padTop: 8, padBottom: 16 };

/** Weekly-ish ticks (1, 8, 15, 22...), always ending on the month's own last day. */
function dayTicks(daysInMonth: number, compact: boolean): readonly number[] {
  const all: number[] = [];
  for (let d = 1; d <= daysInMonth; d += 7) all.push(d);
  const last = all[all.length - 1];
  if (last === undefined || daysInMonth - last >= 3) all.push(daysInMonth);
  else all[all.length - 1] = daysInMonth;
  if (!compact || all.length <= 3) return all;
  const first = all[0]!;
  const final = all[all.length - 1]!;
  const middle = all[Math.floor(all.length / 2)]!;
  return [first, middle, final];
}

function stepDirection(before: number, after: number): TimelineStepDirection {
  return after > before ? "in" : after < before ? "out" : "flat";
}

/**
 * Lays out a month's events as a running total, as the timeline design.md describes: starting at
 * zero on day 1, each day's own net amount accumulates into the day before it; recorded events
 * build the solid, actual line up to today, scheduled ones (an overdue one folded into today's
 * own point) extend it, dashed, to the end of the month.
 */
export function computeTimeline(input: TimelineInput): TimelineLayout {
  const size = input.compact ? COMPACT : FULL;
  const x0 = size.inset;
  const x1 = size.width - size.inset;
  const span = Math.max(1, input.daysInMonth - 1);
  const x = (day: number): number => x0 + ((day - 1) * (x1 - x0)) / span;
  const todayX = input.today === undefined ? undefined : x(input.today);

  const recordedNet = new Map<number, number>();
  const scheduledNet = new Map<number, number>();
  for (const e of input.events) {
    const signed = e.direction === "in" ? e.amountCents : -e.amountCents;
    const bucket = e.status === "recorded" ? recordedNet : scheduledNet;
    bucket.set(e.day, (bucket.get(e.day) ?? 0) + signed);
  }

  // Without "today" (a month that is not the current one), there is nothing left to project:
  // every event — scheduled ones included — is folded straight into the one, solid line.
  const lastActualDay = input.today ?? input.daysInMonth;
  const actual: number[] = [0];
  for (let d = 1; d <= lastActualDay; d++) {
    actual[d] = actual[d - 1]! + (recordedNet.get(d) ?? 0) + (input.today === undefined ? (scheduledNet.get(d) ?? 0) : 0);
  }

  let overdueHere = 0;
  const projected = new Map<number, number>();
  if (input.today !== undefined) {
    for (const [day, amount] of scheduledNet) {
      if (day <= input.today) overdueHere += amount;
    }
    projected.set(input.today, actual[input.today]! + overdueHere);
    for (let d = input.today + 1; d <= input.daysInMonth; d++) {
      projected.set(d, projected.get(d - 1)! + (scheduledNet.get(d) ?? 0));
    }
  }

  const values = [0, ...actual.slice(1, lastActualDay + 1), ...projected.values()];
  let minV = Math.min(...values);
  let maxV = Math.max(...values);
  if (minV === maxV) {
    minV -= 100;
    maxV += 100;
  }
  const plotHeight = size.height - size.padTop - size.padBottom;
  const y = (v: number): number => size.padTop + plotHeight * (1 - (v - minV) / (maxV - minV));

  const segments: TimelineSegment[] = [];
  for (let d = 2; d <= lastActualDay; d++) {
    segments.push({
      from: { day: d - 1, x: x(d - 1), y: y(actual[d - 1]!) },
      to: { day: d, x: x(d), y: y(actual[d]!) },
      direction: stepDirection(actual[d - 1]!, actual[d]!),
      projected: false,
    });
  }
  if (input.today !== undefined) {
    for (let d = input.today + 1; d <= input.daysInMonth; d++) {
      segments.push({
        from: { day: d - 1, x: x(d - 1), y: y(projected.get(d - 1)!) },
        to: { day: d, x: x(d), y: y(projected.get(d)!) },
        direction: stepDirection(projected.get(d - 1)!, projected.get(d)!),
        projected: true,
      });
    }
  }

  const current: TimelineCurrent | undefined =
    input.today === undefined
      ? undefined
      : (() => {
          const currentY = y(actual[input.today!]!);
          // Above the line by default, the same way a price chart's own current-price tag
          // reads — but below it instead when that would run the label past the canvas's own
          // top edge (`#407`), the one case a fixed offset can't always place safely.
          const labelY = currentY - 5 < size.padTop + 10 ? currentY + 14 : currentY - 5;
          return {
            amountCents: actual[input.today!]!,
            y: currentY,
            labelY,
            hasOverdue: overdueHere !== 0,
            overdueY: overdueHere !== 0 ? y(projected.get(input.today!)!) : undefined,
          };
        })();

  return {
    width: size.width,
    height: size.height,
    zeroY: y(0),
    axisX0: x0,
    axisX1: x1,
    todayX,
    dayTicks: dayTicks(input.daysInMonth, input.compact ?? false).map((day) => ({ day, x: x(day) })),
    segments,
    current,
  };
}
