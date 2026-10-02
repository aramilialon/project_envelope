import { TRACK_PERCENT, type Bar as BarGeometry } from "@envelope/core";
import "./Bar.css";

interface Props {
  readonly bar: BarGeometry;
}

/**
 * Renders a category's bar geometry (`@envelope/core`'s `computeCategoryBar`/
 * `computePaymentCategoryBar`, #324): the `.bar`/`.tr`/`.sp`/`.rs`/`.tail`/`.uc` structure
 * `docs/ux/mockups/budget-month.html`'s own CSS styles. Purely decorative (`aria-hidden`) — the
 * category row's own text (name, spent line, available amount) carries the same information for
 * assistive technology, matching the mockup's own `aria-hidden="true"` on its bar markup.
 */
export default function Bar({ bar }: Props) {
  if (bar.kind === "payment") {
    return (
      <span className="bar" aria-hidden="true">
        <span className="tr">
          {bar.uncovered && (
            <span
              className="uc"
              style={{ left: `${bar.uncovered.leftPercent}%`, width: `${bar.uncovered.widthPercent}%` }}
            />
          )}
        </span>
      </span>
    );
  }

  return (
    <span className="bar" aria-hidden="true">
      <span className={`tr${bar.hasBudget ? "" : " empty"}`}>
        <span className="sp" style={{ width: `${bar.spentPercent}%` }} />
        {bar.reserved && (
          <span className="rs" style={{ left: `${bar.reserved.leftPercent}%`, width: `${bar.reserved.widthPercent}%` }} />
        )}
      </span>
      {bar.tail && <span className={`tail ${bar.tail.kind}`} style={{ left: `${TRACK_PERCENT}%`, width: `${bar.tail.widthPercent}%` }} />}
    </span>
  );
}
