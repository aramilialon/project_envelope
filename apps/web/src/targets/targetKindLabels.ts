import type { useIntl } from "react-intl";

import type { GoalKind } from "./api.ts";

/** Display order for the four target kinds, shared by the editor's own radio group and the panel's own section headings. */
export const TARGET_KINDS: readonly GoalKind[] = ["monthly", "by_date", "repeating", "balance"];

export function targetKindLabel(kind: GoalKind, intl: ReturnType<typeof useIntl>): string {
  switch (kind) {
    case "monthly":
      return intl.formatMessage({ id: "targets.kind.monthly.label", defaultMessage: "Monthly amount" });
    case "by_date":
      return intl.formatMessage({ id: "targets.kind.byDate.label", defaultMessage: "Amount by a date" });
    case "repeating":
      return intl.formatMessage({ id: "targets.kind.repeating.label", defaultMessage: "Repeating expense" });
    case "balance":
      return intl.formatMessage({ id: "targets.kind.balance.label", defaultMessage: "Balance to keep" });
  }
}

export function targetKindHint(kind: GoalKind, intl: ReturnType<typeof useIntl>): string {
  switch (kind) {
    case "monthly":
      return intl.formatMessage({ id: "targets.kind.monthly.hint", defaultMessage: "Asks the same amount every month." });
    case "by_date":
      return intl.formatMessage({
        id: "targets.kind.byDate.hint",
        defaultMessage: "Saves up a total by a due month, spread over the months left.",
      });
    case "repeating":
      return intl.formatMessage({
        id: "targets.kind.repeating.hint",
        defaultMessage: 'Like "amount by a date", but the due month moves forward once it passes.',
      });
    case "balance":
      return intl.formatMessage({
        id: "targets.kind.balance.hint",
        defaultMessage: "Asks enough to keep the category's available amount at or above a threshold.",
      });
  }
}
