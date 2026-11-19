import { useEffect, useRef, useState, type FormEvent } from "react";
import { useIntl } from "react-intl";

import { CategoryConflictError } from "./api.ts";
import "./CategoryNameField.css";

export interface CategoryNameFieldProps {
  /** What the name is for: picks the "already used" message (another category in this group, or another group). */
  readonly kind: "category" | "group";
  readonly label: string;
  readonly submitLabel: string;
  readonly initialValue?: string;
  /** Saves the trimmed name; a `CategoryConflictError` it throws is shown under the field. */
  onSubmit(name: string): Promise<void>;
  onCancel(): void;
  /** Empties the field after each save instead of expecting the caller to close it (adding several in a row). */
  readonly stayOpen?: boolean;
}

/**
 * The inline name field (#397, `docs/ux/mockups/budget-categories.html`) for a new category, a new
 * group, or a rename — typed in place, never in a side sheet. Focused (and its text selected) when
 * it opens; Enter saves, Esc cancels. An empty name never reaches the API; a name the API refuses
 * gets one line under the field saying why, and the field stays as typed so it can be corrected.
 */
export default function CategoryNameField({ kind, label, submitLabel, initialValue = "", onSubmit, onCancel, stayOpen = false }: CategoryNameFieldProps) {
  const intl = useIntl();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function messageFor(caught: unknown): string {
    if (caught instanceof CategoryConflictError) {
      switch (caught.code) {
        case "name_taken":
          return kind === "category"
            ? intl.formatMessage({ id: "categoryName.taken.category", defaultMessage: "Another category in this group already has this name." })
            : intl.formatMessage({ id: "categoryName.taken.group", defaultMessage: "Another group already has this name." });
        case "payment_category":
          return intl.formatMessage({ id: "categoryName.paymentCategory", defaultMessage: "A card's payment category is named after its card." });
        case "payment_group":
          return intl.formatMessage({ id: "categoryName.paymentGroup", defaultMessage: "The credit card payments group keeps its own name." });
      }
    }
    return intl.formatMessage({ id: "categoryName.error", defaultMessage: "We could not save this name." });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = value.trim();
    if (!name) {
      setError(intl.formatMessage({ id: "categoryName.empty", defaultMessage: "Type a name." }));
      return;
    }
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name);
      if (stayOpen) {
        setValue("");
        inputRef.current?.focus();
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  const errorId = `${label}-error`.replace(/\s+/g, "-");
  return (
    <form className="name-field" onSubmit={(event) => void handleSubmit(event)}>
      <label>
        <span>{label}</span>
        <input
          ref={inputRef}
          type="text"
          autoComplete="off"
          value={value}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onCancel();
            }
          }}
        />
      </label>
      <button type="submit" className="btn primary" disabled={busy}>
        {submitLabel}
      </button>
      <button type="button" className="btn" onClick={onCancel}>
        {intl.formatMessage({ id: "common.action.cancel", defaultMessage: "Cancel" })}
      </button>
      {error && (
        <p className="err" id={errorId} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
