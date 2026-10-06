import type { Cents } from "../money.ts";

/**
 * The month's own day-by-day timeline (design.md, "Budget month on the desktop" — "Timeline";
 * `docs/ux/mockups/budget-month.html`'s own `timelineSvg`, the literal reference this mirrors).
 * Plain coordinates, lengths and label positions out, never rendered SVG or literal text (no
 * user-facing text in `packages/core`) — `apps/web`'s `Timeline.tsx` draws the actual `<svg>`
 * from this, formatting each label's own amount with `Intl.NumberFormat` at render time. A mark's
 * `label.payees` are the transactions' (or scheduled transactions') own stored payees — raw user
 * data, not UI copy — carried through so the renderer can compose "payees, amount" itself; capped
 * to `MAX_LABEL_PAYEES`, with `extraPayeeCount` for the rest, so a day with many events never
 * grows a label past what `TimelineInput.formatAmount`'s own width estimate actually accounts for.
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

/** At most this many payees are ever spelled out in a label; the rest become `extraPayeeCount` ("+N", composed by the renderer). */
export const MAX_LABEL_PAYEES = 2;

export interface TimelineLabel {
  readonly x: number;
  readonly y: number;
  /** The first `MAX_LABEL_PAYEES` payees sharing this mark (several events landed on the same day, direction and status) — never more, however many actually share it. */
  readonly payees: readonly string[];
  /** How many more payees shared this mark beyond `payees` — 0 when `payees` already lists every one. */
  readonly extraPayeeCount: number;
  /** Its own estimated rendered width (`x` to `x + width` never crosses the canvas's own edge or the "today" line) — `TimelineInput.formatAmount`'s own contribution to it. */
  readonly width: number;
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
  /**
   * Formats a positive amount exactly as the renderer will show it (currency symbol, decimals,
   * locale) — used only to estimate a label's own width for collision avoidance, never exposed in
   * the output (no user-facing text in `packages/core`). Without it, a plain `"1234.56"`-shaped
   * estimate stands in — close enough for tests, but a real caller should always pass its own,
   * since a locale's own symbol and separators can meaningfully change how much room a label needs.
   */
  readonly formatAmount?: (amountCents: Cents) => string;
  /**
   * Formats the payees sharing a mark's own label exactly as the renderer will show them (its own
   * list style, and its own translated "and N more") — used only to estimate a label's own width,
   * same reason and same rule as `formatAmount`. Without it, a plain `"a, b +N"`-shaped estimate
   * stands in; a real caller should always pass its own, since a translated "and N more" is not
   * the same length as "+N" (and some languages need more room still).
   */
  readonly formatPayees?: (payees: readonly string[], extraPayeeCount: number) => string;
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

function defaultFormatAmount(amountCents: Cents): string {
  return (amountCents / 100).toFixed(2);
}

function defaultFormatPayees(payees: readonly string[], extraPayeeCount: number): string {
  return payees.join(", ") + (extraPayeeCount > 0 ? ` +${extraPayeeCount}` : "");
}

/**
 * A label's own estimated rendered width: `text.length * charWidth`, the same crude estimate
 * `docs/ux/mockups/budget-month.html`'s own `timelineSvg` already relies on, never exact font
 * metrics — but the text itself is exactly what gets rendered (`formatPayees`'s own real payee
 * list and "and N more", the sign, `formatAmount`'s own real formatted string), not a stand-in
 * shape, so the estimate stays accurate enough that the amount is never the part that runs off
 * the canvas.
 */
function estimateLabelWidth(
  payees: readonly string[],
  extraPayeeCount: number,
  amountCents: Cents,
  direction: TimelineDirection,
  size: Size,
  formatAmount: (amountCents: Cents) => string,
  formatPayees: (payees: readonly string[], extraPayeeCount: number) => string,
): number {
  const payeeText = formatPayees(payees, extraPayeeCount);
  const sign = direction === "in" ? "+" : "−";
  const amountText = formatAmount(amountCents);
  // +1 for the space between the payee text and the signed amount.
  return (payeeText.length + 1 + sign.length + amountText.length) * size.charWidth;
}

/**
 * Where a label of `width` can go without crossing `leftBound`/`rightBound` (the "today" line on
 * whichever side applies, or the canvas's own edge when there is none) — the stem's own right
 * side first (natural reading order), its left side otherwise, or no room at all (design.md: a
 * label never crosses the "today" line; omitted rather than overlapping it, the mark's own stem
 * and colour already carry the same information without it).
 */
function placeHorizontally(stemX: number, width: number, gap: number, leftBound: number, rightBound: number): number | undefined {
  const right = stemX + gap;
  if (right + width <= rightBound) {
    return right;
  }
  const left = stemX - gap - width;
  if (left >= leftBound) {
    return left;
  }
  return undefined;
}

interface Lane {
  x1: number;
  x2: number;
  y: number;
}

/** A mark's own stem — the vertical line from the axis to `stemY` — as an obstacle a label must also step away from, not just another label (`#351`). */
interface StemObstacle {
  readonly x: number;
  readonly yTop: number;
  readonly yBottom: number;
}

function placeLabel(lane: Lane[], stems: readonly StemObstacle[], x: number, y: number, width: number, step: number, up: boolean): number {
  let placedY = y;
  let collided = true;
  while (collided) {
    collided =
      lane.some((other) => x < other.x2 + 4 && x + width > other.x1 - 4 && Math.abs(placedY - other.y) < step) ||
      stems.some((stem) => x - 4 <= stem.x && stem.x <= x + width + 4 && placedY >= stem.yTop - 4 && placedY <= stem.yBottom + 4);
    if (collided) {
      placedY += up ? -step : step;
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
  const formatAmount = input.formatAmount ?? defaultFormatAmount;
  const formatPayees = input.formatPayees ?? defaultFormatPayees;
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

  // Every mark's own position and stem, computed once up front — so a label can be checked
  // against every OTHER mark's own stem too (`#351`), including a day with no label of its own.
  const positioned = list.map((e) => {
    const up = e.direction === "in";
    const length = markLength(e.amountCents, size);
    const stemY = up ? size.axisY - length : size.axisY + length;
    return { e, up, stemY, ex: x(e.day) };
  });
  const stems: StemObstacle[] = positioned.map(({ ex, stemY }) => ({
    x: ex,
    yTop: Math.min(size.axisY, stemY),
    yBottom: Math.max(size.axisY, stemY),
  }));

  const lanes = { up: [] as Lane[], down: [] as Lane[] };
  const marks: TimelineMark[] = [];
  for (const { e, up, stemY, ex } of positioned) {
    const key = `${e.direction}:${e.status}:${e.day}`;
    const labelled = input.compact ? up : e.direction !== "out" || e.status !== "recorded" || biggestOutKeys.has(key);
    let label: TimelineLabel | undefined;
    if (labelled) {
      const displayedPayees = e.payees.slice(0, MAX_LABEL_PAYEES);
      const extraPayeeCount = Math.max(0, e.payees.length - MAX_LABEL_PAYEES);
      const width = estimateLabelWidth(displayedPayees, extraPayeeCount, e.amountCents, e.direction, size, formatAmount, formatPayees);

      // The "today" line splits the canvas in two for this purpose: a past event's label must
      // stay left of it, a future one's right of it — never crossing it either way (design.md).
      // Without a "today" line at all (not the current month), the only bounds are the canvas's
      // own edges.
      let leftBound = x0;
      let rightBound = size.width - 2;
      if (todayX !== undefined) {
        if (e.day < input.today!) {
          rightBound = todayX - 4;
        } else {
          leftBound = todayX + 4;
        }
      }
      const lx = placeHorizontally(ex, width, size.labelGap, leftBound, rightBound);

      if (lx !== undefined) {
        const lane = up ? lanes.up : lanes.down;
        const ly = placeLabel(lane, stems, lx, up ? stemY : stemY + 4, width, size.laneStep, up);
        label = { x: lx, y: ly, payees: displayedPayees, extraPayeeCount, width };
      }
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
