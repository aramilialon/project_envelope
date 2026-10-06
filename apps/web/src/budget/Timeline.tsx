import type { TimelineLayout } from "@envelope/core";
import { useIntl } from "react-intl";
import { formatPayees } from "./timelineLabels.ts";
import "./Timeline.css";

interface Props {
  readonly layout: TimelineLayout;
  /** The month's own display name ("September 2026"), for the heading and the `aria-label`. */
  readonly monthLabel: string;
  readonly money: (cents: number) => string;
  /**
   * The phone's own small timeline (`#331`, design.md: "keeps only the marks, 'today' and the
   * income still to come"): no heading or note — the band above it already names the month, and
   * there is no room to spare. `layout` itself must come from `computeTimeline({ compact: true })`
   * for the marks/labels to actually match (this prop only trims the surrounding chrome).
   */
  readonly compact?: boolean;
}

/**
 * The month's own day-by-day timeline (`@envelope/core`'s `computeTimeline`, #326): the
 * `.time`/`.t-*` structure `docs/ux/mockups/budget-month.html`'s own CSS styles. The `<svg>` is
 * `aria-hidden` the same way `Bar.tsx`'s is — the heading and note around it, and the category
 * rows and "To do" list beside it, already carry the same information in accessible text.
 */
export default function Timeline({ layout, monthLabel, money, compact }: Props) {
  const intl = useIntl();

  return (
    <div className={`time${compact ? " compact" : ""}`}>
      {!compact && <h5>{intl.formatMessage({ id: "budget.timeline.heading", defaultMessage: "{month}, day by day" }, { month: monthLabel })}</h5>}
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
        {layout.todayX !== undefined && (
          <rect x={layout.todayX} y={4} width={layout.axisX1 - layout.todayX + 6} height={layout.height - 18} className="t-future" />
        )}
        <line x1={layout.axisX0} y1={layout.axisY} x2={layout.axisX1} y2={layout.axisY} className="t-axis" />
        {layout.dayTicks.map((tick) => (
          <text key={tick.day} x={tick.x} y={layout.height - 3} textAnchor="middle" className="t-day">
            {tick.day}
          </text>
        ))}
        {layout.todayX !== undefined && (
          <>
            <line x1={layout.todayX} y1={6} x2={layout.todayX} y2={layout.height - 14} className="t-today" />
            <text x={layout.todayX - 6} y={16} textAnchor="end" className="t-today-l">
              {intl.formatMessage({ id: "budget.timeline.today", defaultMessage: "today" })}
            </text>
          </>
        )}
        {layout.marks.map((mark) => {
          const stemModifier = mark.status === "overdue" ? "t-late" : mark.status === "scheduled" ? `t-${mark.direction} plan` : `t-${mark.direction}`;
          const labelModifier = mark.status === "overdue" ? "t-late" : mark.direction === "in" ? "t-in" : "";
          return (
            <g key={`${mark.direction}:${mark.status}:${mark.day}`}>
              <line x1={mark.x} y1={layout.axisY} x2={mark.x} y2={mark.stemY} className={`t-stem ${stemModifier}`} />
              {mark.label && (
                <text x={mark.label.x} y={mark.label.y} className={labelModifier ? `t-l ${labelModifier}` : "t-l"}>
                  {formatPayees(mark.label.payees, mark.label.extraPayeeCount, intl)} {mark.direction === "in" ? "+" : "−"}
                  {money(mark.amountCents)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {!compact && (
        <p className="t-note">
          {intl.formatMessage({
            id: "budget.timeline.note",
            defaultMessage: "Income above the line, outflows below it; dashed is what has not happened yet, and length grows with the amount.",
          })}
        </p>
      )}
    </div>
  );
}
