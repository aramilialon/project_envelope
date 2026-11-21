import { useEffect, useRef, type ReactNode } from "react";
import { useIntl } from "react-intl";

interface Props {
  readonly label: string;
  /** Full screen with a "← Back" link (the phone row/to-do detail, `#331`) instead of inline under the row with "× Close" (the desktop one, `#327`) — same content either way. */
  readonly fullScreen?: boolean;
  /**
   * Brings the detail into view and moves focus to it whenever this value changes to a defined one
   * (#728): set when the detail was opened from somewhere else on the screen (a "To do" item, a
   * category's link to its card), and always on the phone, whose detail replaces the list the
   * person was looking at. Inline, the detail scrolls only as far as needed (`block: "nearest"`);
   * full screen, to its top. Focus goes to the detail's own heading (`.det-h h3`, made focusable
   * with `tabIndex={-1}` by the detail itself), or to the region when it has none showing.
   */
  readonly focusRequest?: string | number | undefined;
  onClose(): void;
  readonly children: ReactNode;
}

/**
 * The one wrapper `RowDetail.tsx` and `PaymentCategoryDetail.tsx` both open in: a category's own
 * detail is never a side sheet (that is for month-wide tools, `SideSheet.tsx`), inline under its
 * own row on the desktop, full screen with a back link on the phone (design.md, "Budget month on
 * the phone") — the same content either way, only the chrome around it differs.
 */
export default function DetailFrame({ label, fullScreen = false, focusRequest, onClose, children }: Props) {
  const intl = useIntl();
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = frame.current;
    if (focusRequest === undefined || !node) return;
    // jsdom has no `scrollIntoView`; every browser does.
    node.scrollIntoView?.({ block: fullScreen ? "start" : "nearest" });
    const heading = node.querySelector<HTMLElement>(".det-h h3");
    (heading ?? node).focus({ preventScroll: true });
    // Only a new request moves focus: re-renders of the same open detail leave it where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  if (fullScreen) {
    return (
      <div ref={frame} className="ph-detail" role="region" aria-label={label} tabIndex={-1}>
        <button type="button" className="ph-back" onClick={onClose}>
          ←{intl.formatMessage({ id: "budget.phone.back", defaultMessage: "Budget" })}
        </button>
        <div className="inl-c">{children}</div>
      </div>
    );
  }

  return (
    <div ref={frame} className="inl" role="region" aria-label={label} tabIndex={-1}>
      <button type="button" className="plain closer" onClick={onClose}>
        {intl.formatMessage({ id: "common.action.close", defaultMessage: "× Close" })}
      </button>
      <div className="inl-c">{children}</div>
    </div>
  );
}
