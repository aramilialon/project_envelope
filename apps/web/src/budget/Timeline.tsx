import type { TimelineLayout } from "@envelope/core";
import { useIntl } from "react-intl";
import "./Timeline.css";

interface Props {
  readonly layout: TimelineLayout;
  /** The month's own display name ("September 2026"), for the heading and the `aria-label`. */
  readonly monthLabel: string;
  readonly money: (cents: number) => string;
  /**
   * The phone's own small timeline (`#331`, design.md: "keeps only the running line and 'today'"):
   * no heading or note, and no current-value label — the band above it
   * already names the month, and there is no room to spare. `layout` itself must come from
   * `computeTimeline({ compact: true })` for the sizes to actually match (this prop only trims
   * the surrounding chrome).
   */
  readonly compact?: boolean;
}

/**
 * The month's own day-by-day timeline (`@envelope/core`'s `computeTimeline`, `#326`, redesigned
 * `#390`): the `.time`/`.t-*` structure `docs/ux/mockups/budget-month.html`'s own CSS styles. A
 * running total, not a per-event mark — solid up to today, dashed past it, each day's own step
 * coloured `t-in`/`t-out`/`t-flat` by `TimelineSegment.direction` (never the app's own `red`/
 * `amber`, reserved for a real problem) — with a dashed "current value" reference line at today's
 * own height and its amount, the equivalent of a price chart's own current-price tag. The `<svg>`
 * is `aria-hidden` the same way `Bar.tsx`'s is — the heading and note around it, and the category
 * rows and "To do" list beside it, already carry the same information in accessible text.
 */
export default function Timeline({ layout, monthLabel, money, compact }: Props) {
  const intl = useIntl();
  const current = layout.current;

  return (
    <div className={`time${compact ? " compact" : ""}`}>
      {!compact && <h5>{intl.formatMessage({ id: "budget.timeline.heading", defaultMessage: "{month}, day by day" }, { month: monthLabel })}</h5>}
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
        {layout.todayX !== undefined && (
          <rect x={layout.todayX} y={4} width={layout.axisX1 - layout.todayX + 6} height={layout.height - 18} className="t-future" />
        )}
        <line x1={layout.axisX0} y1={layout.zeroY} x2={layout.axisX1} y2={layout.zeroY} className="t-axis" />
        {layout.dayTicks.map((tick) => (
          <text key={tick.day} x={tick.x} y={layout.height - 3} textAnchor="middle" className="t-day">
            {tick.day}
          </text>
        ))}
        {layout.segments.map((segment) => (
          <line
            key={`${segment.projected}:${segment.to.day}`}
            x1={segment.from.x}
            y1={segment.from.y}
            x2={segment.to.x}
            y2={segment.to.y}
            className={`t-line t-${segment.direction}${segment.projected ? " plan" : ""}`}
          />
        ))}
        {layout.todayX !== undefined && (
          <>
            <line x1={layout.todayX} y1={6} x2={layout.todayX} y2={layout.height - 14} className="t-today" />
            <text x={layout.todayX - 6} y={16} textAnchor="end" className="t-today-l">
              {intl.formatMessage({ id: "budget.timeline.today", defaultMessage: "today" })}
            </text>
          </>
        )}
        {current && (
          <>
            <line x1={layout.todayX} y1={current.y} x2={layout.axisX1} y2={current.y} className="t-cur" />
            {!compact && (
              <text x={layout.axisX1 - 2} y={current.labelY} textAnchor="end" className="t-cur-l">
                {current.amountCents >= 0 ? "+" : ""}
                {money(current.amountCents)}
              </text>
            )}
            {current.hasOverdue && (
              <circle cx={layout.todayX} cy={current.overdueY} r={3.5} className="t-overdue" />
            )}
          </>
        )}
      </svg>
      {!compact && (
        <p className="t-note">
          {intl.formatMessage({
            id: "budget.timeline.note",
            defaultMessage: "What has moved so far this month, not your account balance; dashed is what has not happened yet.",
          })}
        </p>
      )}
    </div>
  );
}
