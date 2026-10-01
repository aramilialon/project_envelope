import { useEffect, useRef, type ReactNode } from "react";
import { useIntl } from "react-intl";
import "./SideSheet.css";

interface Props {
  readonly title: string;
  onClose(): void;
  readonly children: ReactNode;
}

// Real controls only: a tabIndex={-1} title is reachable with .focus() but must not be part of
// the Tab cycle, so it is deliberately excluded here.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The shared side sheet (#323, docs/ux/README.md's component catalog): the fixed-width panel
 * every entity's detail form and month-wide tool opens in — `AddAccountForm` here, and
 * `TargetsPanel`/`QuickAssignPanel`/`TargetEditor`/`TransactionForm` once their own issues move
 * them off the old `.side-panel` drawer this replaces. Closes on "× Close", Esc, or whatever the
 * caller wires to a second click of the thing that opened it.
 *
 * A `role="dialog"` with `aria-modal="true"` is a lie to assistive tech unless focus actually
 * behaves modally: on mount, focus moves to the first focusable field in `children` (the title
 * itself, focusable via `tabIndex={-1}`, when there is none); Tab/Shift+Tab cycle within the
 * sheet instead of escaping to the page behind it; on unmount, focus returns to whatever opened
 * it. Callers render this conditionally (`{open && <SideSheet>...}`), so mount/unmount already
 * line up exactly with open/close — no separate "did it close" signal needed.
 *
 * The mockup's own side sheet is a grid column that narrows the page's main content while open
 * (docs/design.md: "narrows the bars while it is open") — that needs the hosting screen's own
 * layout to reserve a column for it, which no screen in this foundational issue has yet. This
 * version is a correct, accessible overlay (fixed position, like the old `.side-panel`); the
 * narrowing behaviour is each consuming issue's own job once it has real content to narrow.
 */
export default function SideSheet({ title, onClose, children }: Props) {
  const intl = useIntl();
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const firstField = bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (firstField ?? titleRef.current)?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !rootRef.current) {
        return;
      }
      const focusable = Array.from(rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="side-sheet" role="dialog" aria-modal="true" aria-label={title} ref={rootRef}>
      <div className="panel-head">
        <h2 ref={titleRef} tabIndex={-1}>
          {title}
        </h2>
        <button type="button" className="plain" onClick={onClose}>
          {intl.formatMessage({ id: "common.action.close", defaultMessage: "× Close" })}
        </button>
      </div>
      <div ref={bodyRef}>{children}</div>
    </div>
  );
}
