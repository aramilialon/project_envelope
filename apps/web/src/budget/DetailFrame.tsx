import type { ReactNode } from "react";
import { useIntl } from "react-intl";

interface Props {
  readonly label: string;
  /** Full screen with a "← Back" link (the phone row/to-do detail, `#331`) instead of inline under the row with "× Close" (the desktop one, `#327`) — same content either way. */
  readonly fullScreen?: boolean;
  onClose(): void;
  readonly children: ReactNode;
}

/**
 * The one wrapper `RowDetail.tsx` and `PaymentCategoryDetail.tsx` both open in: a category's own
 * detail is never a side sheet (that is for month-wide tools, `SideSheet.tsx`), inline under its
 * own row on the desktop, full screen with a back link on the phone (design.md, "Budget month on
 * the phone") — the same content either way, only the chrome around it differs.
 */
export default function DetailFrame({ label, fullScreen = false, onClose, children }: Props) {
  const intl = useIntl();

  if (fullScreen) {
    return (
      <div className="ph-detail" role="region" aria-label={label}>
        <button type="button" className="ph-back" onClick={onClose}>
          ←{intl.formatMessage({ id: "budget.phone.back", defaultMessage: "Budget" })}
        </button>
        <div className="inl-c">{children}</div>
      </div>
    );
  }

  return (
    <div className="inl" role="region" aria-label={label}>
      <button type="button" className="plain closer" onClick={onClose}>
        {intl.formatMessage({ id: "common.action.close", defaultMessage: "× Close" })}
      </button>
      <div className="inl-c">{children}</div>
    </div>
  );
}
