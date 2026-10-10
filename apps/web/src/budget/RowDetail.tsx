import { currencyDecimals, parseAmount } from "@envelope/core";
import { useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import { createAssignments } from "./api.ts";
import DetailFrame from "./DetailFrame.tsx";
import "./RowDetail.css";

interface Props {
  readonly workspaceId: string;
  readonly month: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly assigned: number;
  readonly currency: string;
  onClose(): void;
  /** Called once the assigned amount actually changes — the budget month needs refetching. */
  onChanged(): void;
  /** Opens the "Move money" form (#328) preselecting this category as the destination. */
  onMoveMoney(): void;
  /** Full screen with a back link, not inline under the row (the phone layout, `#331`). */
  readonly fullScreen?: boolean;
  /** A `read_only` member (#61, design.md: "resolving any of these needs the owner or editor role") still sees this detail, just not its own edit controls. */
  readonly readOnly?: boolean;
}

/** A plain, locale-formatted number, no currency symbol — the field's own displayed value, same convention `AccountRegisterScreen.tsx`'s own `plainAmount` uses for an editable/tabular amount. */
function plainAmount(cents: number, locale: string, currency: string): string {
  const decimals = currencyDecimals(currency);
  return new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(cents / 10 ** decimals);
}

/**
 * A category's detail, opening in its own row under its bar (design.md, "A category's detail";
 * #327) — not a side sheet, which is for month-wide tools instead. Only the assigned amount is
 * editable here so far: typing a new amount, or "+20"/"-15" for a change, and leaving the field
 * (Enter, or clicking away) commits the difference as one assignment entry through the existing
 * `POST /assignments` — no new endpoint. The rest of the mockup's own three-column detail (the
 * target meter, the scheduled list, the ledger, quick assign, the assignment and transaction
 * history) is later issues' own job, layered onto this same row.
 */
export default function RowDetail({ workspaceId, month, categoryId, categoryName, assigned, currency, onClose, onChanged, onMoveMoney, fullScreen, readOnly }: Props) {
  const intl = useIntl();
  const auth = useAuth();
  const [value, setValue] = useState(() => plainAmount(assigned, intl.locale, currency));
  const cancelingRef = useRef(false);
  const committingRef = useRef(false);

  function revert() {
    setValue(plainAmount(assigned, intl.locale, currency));
  }

  async function commit(raw: string) {
    const text = raw.trim();
    if (!text) {
      revert();
      return;
    }
    const relative = text.startsWith("+") || text.startsWith("-");
    let magnitude: number;
    try {
      magnitude = parseAmount(relative ? text.slice(1) : text, { locale: intl.locale, currency });
    } catch {
      // Not a parseable amount: left as the user typed it, rather than silently discarding what
      // they are still in the middle of correcting.
      return;
    }
    const goal = relative ? assigned + (text.startsWith("+") ? magnitude : -magnitude) : magnitude;
    const diff = goal - assigned;
    if (diff === 0) {
      revert();
      return;
    }
    const accessToken = auth.user?.access_token;
    if (!accessToken || committingRef.current) {
      return;
    }
    committingRef.current = true;
    try {
      await createAssignments(accessToken, workspaceId, [
        diff > 0
          ? { month, sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: diff }
          : { month, sourceCategoryId: categoryId, destinationCategoryId: null, amountCents: -diff },
      ]);
      onChanged();
    } finally {
      committingRef.current = false;
    }
  }

  return (
    <DetailFrame
      label={intl.formatMessage({ id: "budget.row.detailLabel", defaultMessage: "Detail for {category}" }, { category: categoryName })}
      fullScreen={fullScreen ?? false}
      onClose={onClose}
    >
      <div className="sec">
        <div className="qa asg-l">
          <label htmlFor={`asg-${categoryId}`}>{intl.formatMessage({ id: "budget.row.assigned", defaultMessage: "Assigned this month" })}</label>
          <span className="dots" />
          <input
            id={`asg-${categoryId}`}
            type="text"
            inputMode="decimal"
            className="asg-in n"
            value={value}
            readOnly={readOnly}
            aria-describedby={`asg-h-${categoryId}`}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                cancelingRef.current = true;
                event.currentTarget.blur();
              }
            }}
            onBlur={(event) => {
              if (cancelingRef.current) {
                cancelingRef.current = false;
                revert();
                return;
              }
              void commit(event.target.value);
            }}
          />
        </div>
        <small className="asg-h" id={`asg-h-${categoryId}`}>
          {intl.formatMessage({ id: "budget.row.assignedHint", defaultMessage: "Type an amount, or +20 / -15, then Enter." })}
        </small>
        {!readOnly && (
          <button type="button" className="plain" onClick={onMoveMoney}>
            {intl.formatMessage({ id: "budget.row.moveMoney", defaultMessage: "Move money" })}
          </button>
        )}
      </div>
    </DetailFrame>
  );
}
