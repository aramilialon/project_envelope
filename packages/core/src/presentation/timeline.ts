import type { Cents } from "../money.ts";

/**
 * The month's own day-by-day timeline (design.md, "Budget month on the desktop" — "Timeline";
 * `docs/ux/mockups/budget-month.html`'s own `timelineSvg`, the literal reference this mirrors).
 * Plain coordinates, lengths and label positions out, never rendered SVG or literal text (no
 * user-facing text in `packages/core`) — `apps/web`'s `Timeline.tsx` draws the actual `<svg>`
 * from this, formatting each label's own amount with `Intl.NumberFormat` at render time. A mark's
 * `label.payee` is the transaction's (or scheduled transaction's) own stored payee — raw user
 * data, not UI copy — carried through so the renderer can compose "payee, amount" itself.
 *
 * Reused as-is by `#337` (the account register's own timeline): the layout math does not care
 * whether the events are workspace-wide or one account's own, only `compact` (the account
 * register's own, smaller rendering) changes the numbers.
 */

export type TimelineDirection = "in" | "out";
/** `recorded`: a real transaction, drawn solid. `scheduled`: not yet due, dashed. `overdue`: scheduled, dashed and amber. */
export type TimelineEventStatus = "recorded" | "scheduled" | "overdue";

export interface TimelineEvent {
  /** 1-based day of the month. */
  readonly day: number;
  /** Always positive — `direction` says which way it moves. */
  readonly amountCents: Cents;
  readonly direction: TimelineDirection;
  readonly status: TimelineEventStatus;
  /** The transaction's (or scheduled transaction's) own payee — raw data, never composed UI text. */
  readonly payee: string;
}

export interface TimelineLabel {
  readonly x: number;
  readonly y: number;
  /** The one or more payees sharing this mark (several events landed on the same day, direction and status). */
  readonly payees: readonly string[];
}

export interface TimelineMark {
  readonly day: number;
  readonly direction: TimelineDirection;
  readonly status: TimelineEventStatus;
  /** Net of every event sharing this mark's day, direction and status. */
  readonly amountCents: Cents;
  readonly x: number;
  /** Where the mark's own stem ends — the axis is `TimelineLayout.axisY`. */
  readonly stemY: number;
  /** Present only for a mark design.md calls out: the largest recorded outflows, everything still to come, and all income. */
  readonly label: TimelineLabel | undefined;
}

export interface TimelineDayTick {
  readonly day: number;
  readonly x: number;
}

export interface TimelineLayout {
  readonly width: number;
  readonly height: number;
  readonly axisY: number;
  readonly axisX0: number;
  readonly axisX1: number;
  /** The "today" line's own x, and the start of the lighter "future" ground past it — absent when the month shown is not the current one. */
  readonly todayX: number | undefined;
  readonly dayTicks: readonly TimelineDayTick[];
  readonly marks: readonly TimelineMark[];
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
  readonly axisY: number;
  readonly inset: number;
  readonly lengthScale: number;
  readonly lengthBase: number;
  readonly maxLength: number;
  readonly charWidth: number;
  readonly labelGap: number;
  readonly laneStep: number;
}

const FULL: Size = { width: 660, height: 200, axisY: 100, inset: 20, lengthScale: 1.15, lengthBase: 10, maxLength: 72, charWidth: 6.4, labelGap: 6, laneStep: 13 };
const COMPACT: Size = { width: 330, height: 120, axisY: 62, inset: 12, lengthScale: 0.7, lengthBase: 6, maxLength: 40, charWidth: 6, labelGap: 6, laneStep: 13 };

/** Mark length grows with the square root of the amount (design.md), so a mortgage payment and a coffee both stay readable. */
function markLength(amountCents: Cents, size: Size): number {
  const euros = amountCents / 100;
  return Math.min(size.maxLength, Math.sqrt(euros) * size.lengthScale + size.lengthBase);
}

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

/**
 * A label's own estimated rendered width, in the absence of a real one: `packages/core` never
 * formats currency (no user-facing text), so this stands in for "payee list + a formatted
 * amount" using only the payee text's own length and the amount's digit count — close enough for
 * collision avoidance, the same crude estimate `docs/ux/mockups/budget-month.html`'s own
 * `timelineSvg` already relies on (`text.length * charWidth`), never exact font metrics.
 */
function estimateLabelWidth(payees: readonly string[], amountCents: Cents, size: Size): number {
  const payeeText = payees.join(", ");
  const digits = Math.max(1, String(Math.round(Math.abs(amountCents) / 100)).length);
  // +1 for the sign ("+" or "−"), +1 for the space between the payee text and the amount.
  return (payeeText.length + digits + 2) * size.charWidth;
}

interface Lane {
  x1: number;
  x2: number;
  y: number;
}

function placeLabel(lane: Lane[], x: number, y: number, width: number, step: number, up: boolean): number {
  let placedY = y;
  for (let i = 0; i < lane.length; i++) {
    const other = lane[i]!;
    if (x < other.x2 + 4 && x + width > other.x1 - 4 && Math.abs(placedY - other.y) < step) {
      placedY += up ? -step : step;
      i = -1;
    }
  }
  lane.push({ x1: x, x2: x + width, y: placedY });
  return placedY;
}

/**
 * Lays out a month's events as the timeline design.md describes: outflows hang below the axis,
 * income rises above it; recorded movements are solid, scheduled ones dashed, an overdue one
 * amber (`TimelineMark.status`, left to the renderer); the largest outflows, everything still to
 * come and all income carry a label that never crosses the "today" line, stepping down a line
 * instead of overlapping another one already placed.
 */
export function computeTimeline(input: TimelineInput): TimelineLayout {
  const size = input.compact ? COMPACT : FULL;
  const x0 = size.inset;
  const x1 = size.width - size.inset;
  const span = Math.max(1, input.daysInMonth - 1);
  const x = (day: number): number => x0 + ((day - 1) * (x1 - x0)) / span;
  const todayX = input.today === undefined ? undefined : x(input.today);

  const buckets = new Map<string, { day: number; direction: TimelineDirection; status: TimelineEventStatus; amountCents: number; payees: string[] }>();
  for (const e of input.events) {
    const k = `${e.direction}:${e.status}:${e.day}`;
    const existing = buckets.get(k);
    if (existing) {
      existing.amountCents += e.amountCents;
      existing.payees.push(e.payee);
    } else {
      buckets.set(k, { day: e.day, direction: e.direction, status: e.status, amountCents: e.amountCents, payees: [e.payee] });
    }
  }
  const list = [...buckets.values()].sort((a, b) => a.day - b.day);

  // The four largest recorded outflows get a label even though ordinary recorded outflows
  // otherwise do not (design.md: "the largest outflows, everything still to come and all income").
  const biggestOut = list
    .filter((e) => e.direction === "out" && e.status === "recorded")
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, 4);
  const biggestOutKeys = new Set(biggestOut.map((e) => `${e.direction}:${e.status}:${e.day}`));

  const lanes = { up: [] as Lane[], down: [] as Lane[] };
  const marks: TimelineMark[] = [];
  for (const e of list) {
    const up = e.direction === "in";
    const length = markLength(e.amountCents, size);
    const stemY = up ? size.axisY - length : size.axisY + length;
    const ex = x(e.day);

    const key = `${e.direction}:${e.status}:${e.day}`;
    const labelled = input.compact ? up : e.direction !== "out" || e.status !== "recorded" || biggestOutKeys.has(key);
    let label: TimelineLabel | undefined;
    if (labelled) {
      const width = estimateLabelWidth(e.payees, e.amountCents, size);
      let lx = ex + size.labelGap;
      let ly = up ? stemY : stemY + 4;
      if (todayX !== undefined) {
        const past = e.day < input.today!;
        // Shifted left to clear the "today" line, but never past the chart's own left edge — an
        // early-month event (close to `x0` already) would otherwise run its label off-canvas.
        if (past && lx + width > todayX - 4) lx = Math.max(x0, ex - size.labelGap - width);
        if (!past && lx + width > size.width - 2) {
          lx = Math.max(todayX + 4, size.width - 2 - width);
          ly = up ? stemY - 6 : stemY + 14;
        }
      } else if (lx + width > size.width - 2) {
        lx = size.width - 2 - width;
      }
      const lane = up ? lanes.up : lanes.down;
      ly = placeLabel(lane, lx, ly, width, size.laneStep, up);
      label = { x: lx, y: ly, payees: e.payees };
    }

    marks.push({ day: e.day, direction: e.direction, status: e.status, amountCents: e.amountCents, x: ex, stemY, label });
  }

  return {
    width: size.width,
    height: size.height,
    axisY: size.axisY,
    axisX0: x0,
    axisX1: x1,
    todayX,
    dayTicks: dayTicks(input.daysInMonth, input.compact ?? false).map((day) => ({ day, x: x(day) })),
    marks,
  };
}
