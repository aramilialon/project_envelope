/**
 * The random walk's source of choices (ADR 0013): every number, date, time and id the walk makes
 * up comes from one seeded `mulberry32`, so a seed always gives the same walk against the same
 * API. Dates fall in a fixed past window (there is no injectable clock yet), with times picked
 * around UTC month ends and the two DST changes of `Europe/Rome` inside it.
 */
import { mulberry32 } from "@envelope/core/testing";

export const WALK_TIME_ZONE = "Europe/Rome";

/** The walk's dates, both included: a winter and a summer DST change, and a year end. */
export const WINDOW_START = "2025-09-01";
export const WINDOW_END = "2026-04-30";
export const WINDOW_MONTHS = ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04"] as const;

/**
 * Instants where a UTC date and the `Europe/Rome` date differ, or where the offset changes: the
 * last hour of a month in UTC (already the next month in Rome), the repeated hour of
 * 2025-10-26 and the skipped one of 2026-03-29, the year end.
 */
export const EDGE_INSTANTS: readonly string[] = [
  "2025-09-30T22:30:00Z",
  "2025-09-30T21:59:59Z",
  "2025-10-26T00:30:00Z",
  "2025-10-26T01:30:00Z",
  "2025-10-31T22:59:59Z",
  "2025-10-31T23:00:00Z",
  "2025-11-30T23:30:00Z",
  "2025-12-31T22:59:59Z",
  "2025-12-31T23:30:00Z",
  "2026-01-31T23:00:00Z",
  "2026-02-28T22:59:59Z",
  "2026-03-29T00:59:59Z",
  "2026-03-29T01:00:00Z",
  "2026-03-31T21:59:59Z",
  "2026-03-31T22:00:00Z",
];

const DAY_MS = 86_400_000;
const localDateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: WALK_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** The `Europe/Rome` date of an instant, "YYYY-MM-DD": what the API calls a transaction's budget date. */
export function localDateOf(instant: string): string {
  return localDateFormat.format(new Date(instant));
}

const localTimeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: WALK_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * Midnight of a date in `Europe/Rome`, as an ISO instant: where a cash leg is dated (ADR 0012).
 * It is 23:00 UTC of the day before in winter, 22:00 UTC in summer.
 */
export function localMidnight(date: string): string {
  const previous = addDays(date, -1);
  for (const candidate of [`${previous}T23:00:00.000Z`, `${previous}T22:00:00.000Z`]) {
    if (localDateOf(candidate) === date && localTimeFormat.format(new Date(candidate)) === "00:00") return candidate;
  }
  throw new Error(`no midnight found for ${date} in ${WALK_TIME_ZONE}`);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

const WINDOW_DAYS = daysBetween(WINDOW_START, WINDOW_END);

export class WalkRandom {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  float(): number {
    return this.next();
  }

  /** An integer in [min, max], both included. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("pick from an empty list");
    }
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** One of `entries`, each as likely as its weight; entries of weight 0 never. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      if (weight <= 0) continue;
      roll -= weight;
      if (roll < 0) return value;
    }
    const last = entries.filter(([, weight]) => weight > 0).at(-1);
    if (!last) throw new Error("weighted pick with no positive weight");
    return last[0];
  }

  /** A version 4 UUID made from the seed, so a client-generated id replays identically. */
  uuid(): string {
    const hex = Array.from({ length: 32 }, () => this.int(0, 15).toString(16));
    hex[12] = "4";
    hex[16] = ((this.int(0, 15) & 0x3) | 0x8).toString(16);
    const s = hex.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }

  /**
   * A local date that follows the walk's progress through the window (`progress` in [0, 1]), now
   * and then backdated by up to two months, so later trades and transactions land before earlier
   * ones too.
   */
  date(progress: number): string {
    const cursor = Math.round(progress * WINDOW_DAYS);
    const offset = this.chance(0.2) ? -this.int(0, 60) : this.int(-5, 3);
    return addDays(WINDOW_START, Math.min(WINDOW_DAYS, Math.max(0, cursor + offset)));
  }

  /**
   * A transaction's `occurredAt`: a plain date (midnight in the workspace's time zone), a time on
   * that date in UTC, or one of the edge instants.
   */
  occurredAt(progress: number): string {
    const roll = this.float();
    if (roll < 0.15) {
      return this.pick(EDGE_INSTANTS);
    }
    const date = this.date(progress);
    if (roll < 0.5) {
      return date;
    }
    // The window's last day ends at 22:00 UTC (midnight in Rome): no later hour on it, so every
    // budget date stays inside the window.
    const lastHour = date === WINDOW_END ? 21 : 23;
    return `${date}T${String(this.int(0, lastHour)).padStart(2, "0")}:${this.pick(["00", "30", "59"])}:00Z`;
  }

  /**
   * A trade time on `tradeDate` in the workspace's time zone, or none: one of a few times near the
   * day's ends in UTC that still fall on the date in Rome, or an edge instant on that date.
   */
  tradeTime(tradeDate: string): string | undefined {
    if (this.chance(0.4)) {
      return undefined;
    }
    const previous = addDays(tradeDate, -1);
    const candidates = [
      `${tradeDate}T10:15:00Z`,
      `${tradeDate}T00:30:00Z`,
      `${tradeDate}T21:59:59Z`,
      `${tradeDate}T22:30:00.123Z`,
      `${previous}T23:15:00Z`,
      `${tradeDate}T09:00:00+01:00`,
      ...EDGE_INSTANTS,
    ].filter((instant) => localDateOf(instant) === tradeDate);
    return this.pick(candidates);
  }
}

/** Every date in the window is on or before this one: the month the model-free budget invariant is read in. */
export const LAST_MONTH = WINDOW_MONTHS[WINDOW_MONTHS.length - 1]!;
