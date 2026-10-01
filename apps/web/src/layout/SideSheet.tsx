import { useEffect, type ReactNode } from "react";
import { useIntl } from "react-intl";
import "./SideSheet.css";

interface Props {
  readonly title: string;
  onClose(): void;
  readonly children: ReactNode;
}

/**
 * The shared side sheet (#323, docs/ux/README.md's component catalog): the fixed-width panel
 * every entity's detail form and month-wide tool opens in — `AddAccountForm` here, and
 * `TargetsPanel`/`QuickAssignPanel`/`TargetEditor`/`TransactionForm` once their own issues move
 * them off the old `.side-panel` drawer this replaces. Closes on "× Close", Esc, or whatever the
 * caller wires to a second click of the thing that opened it.
 *
 * The mockup's own side sheet is a grid column that narrows the page's main content while open
 * (docs/design.md: "narrows the bars while it is open") — that needs the hosting screen's own
 * layout to reserve a column for it, which no screen in this foundational issue has yet. This
 * version is a correct, accessible overlay (fixed position, like the old `.side-panel`); the
 * narrowing behaviour is each consuming issue's own job once it has real content to narrow.
 */
export default function SideSheet({ title, onClose, children }: Props) {
  const intl = useIntl();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="side-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <div className="panel-head">
        <h2>{title}</h2>
        <button type="button" className="plain" onClick={onClose}>
          {intl.formatMessage({ id: "common.action.close", defaultMessage: "× Close" })}
        </button>
      </div>
      {children}
    </div>
  );
}
