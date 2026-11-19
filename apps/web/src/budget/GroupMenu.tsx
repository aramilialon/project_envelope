import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";

import "./GroupMenu.css";

export interface GroupMenuProps {
  readonly groupName: string;
  /**
   * The shared "Credit card payments" group (#397): its categories follow their cards and the API
   * finds it by its exact name, so it offers neither "Add a category" nor "Rename group" — only
   * the way to Workspace settings.
   */
  readonly isPaymentGroup: boolean;
  onAddCategory(): void;
  onRename(): void;
  /** "Reorder or archive…": Workspace settings → Categories, the full management view. */
  onManage(): void;
}

/**
 * A group row's own "⋯" menu on the budget month (#397, `docs/ux/mockups/budget-categories.html`):
 * one quiet button per group rather than three icons, opening add a category, rename the group,
 * and the way to Workspace settings for reordering and archiving. Closes on a choice, on Escape,
 * or on a click anywhere else. The caller renders it only for an owner or an editor.
 */
export default function GroupMenu({ groupName, isPaymentGroup, onAddCategory, onRename, onManage }: GroupMenuProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const label = intl.formatMessage({ id: "budget.groupMenu.label", defaultMessage: "Actions for {name}" }, { name: groupName });

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="gmenu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="gmenu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div className="gmenu-pop" role="menu" aria-label={label}>
          {!isPaymentGroup && (
            <>
              <button type="button" role="menuitem" onClick={() => choose(onAddCategory)}>
                {intl.formatMessage({ id: "budget.groupMenu.addCategory", defaultMessage: "Add a category" })}
              </button>
              <button type="button" role="menuitem" onClick={() => choose(onRename)}>
                {intl.formatMessage({ id: "budget.groupMenu.rename", defaultMessage: "Rename group" })}
              </button>
              <hr />
            </>
          )}
          <button type="button" role="menuitem" className="quiet" onClick={() => choose(onManage)}>
            {intl.formatMessage({ id: "budget.groupMenu.manage", defaultMessage: "Reorder or archive… (Workspace settings)" })}
          </button>
        </div>
      )}
    </div>
  );
}
