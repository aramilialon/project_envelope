import { formatMoney } from "@envelope/core";
import { useIntl } from "react-intl";

import DetailFrame from "./DetailFrame.tsx";
import "./RowDetail.css";

interface Props {
  readonly categoryName: string;
  /** Money set aside to pay the card — `BudgetGroupCategory.available`. */
  readonly available: number;
  /** How much of the card's real balance no assigned money covers yet. */
  readonly uncovered: number;
  /** Whether the card had a starting balance when added (#355) — picks the specific "already had debt" sentence over the generic one. */
  readonly hasStartingBalance?: boolean;
  /** Which ordinary categories' credit overspending this month is attributable to this card, with their own names and amounts (#355). */
  readonly overspendingBy?: readonly { readonly categoryId: string; readonly name: string; readonly amount: number }[];
  readonly currency: string;
  onClose(): void;
  /** "Assign €X from unassigned money": opens the move-money form with the source forced to unassigned. */
  onAssignFromUnassigned(): void;
  /** "Move money here": opens the move-money form with no source forced — any category can cover it. */
  onMoveMoneyHere(): void;
  /** Full screen with a back link, not inline under the row (the phone layout, `#331`). */
  readonly fullScreen?: boolean;
  /** A `read_only` member (#61, design.md: "resolving any of these needs the owner or editor role") still sees this detail, just not its own two actions. */
  readonly readOnly?: boolean;
}

/**
 * A card's own payment category detail, opening in its own row exactly like an ordinary
 * category's (`RowDetail.tsx`, #327) — design.md's "Card payment category": money set aside, a
 * sentence about the card's debt, the debt itself (balance, set aside, to cover) when any of it
 * is uncovered, and the two actions #328's `MoveMoneyForm` already provides (reused here, not a
 * separate one-click commit the way the reference mockup's own shortcut button does). Picks the
 * mockup's own two more specific sentences when the data for them is available (#355): a starting
 * balance (`hasStartingBalance`, priority over the other when both apply, same as the mockup's own
 * `payDetail`) or the named categories whose card spending caused it (`overspendingBy`) —
 * simplified from the mockup's own starting-balance sentence, which also names the exact amount
 * and date; this API only exposes whether one exists at all (design.md: "the amount and date are
 * already on the account/transaction itself"). Falls back to the generic sentence when neither
 * applies but the debt is still uncovered.
 *
 * The month's own ledger, assignment history and transaction history (the rest of design.md's
 * own three-column list for this row) are deliberately not built here, the same way #327 left
 * them out of an ordinary category's own detail — no issue has fetched that data yet.
 */
export default function PaymentCategoryDetail({
  categoryName,
  available,
  uncovered,
  hasStartingBalance,
  overspendingBy,
  currency,
  onClose,
  onAssignFromUnassigned,
  onMoveMoneyHere,
  fullScreen,
  readOnly,
}: Props) {
  const intl = useIntl();
  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency });
  const covered = uncovered <= 0;
  const debt = covered ? 0 : available + uncovered;

  function explanation(): string {
    if (covered) {
      return intl.formatMessage({
        id: "budget.payment.covered",
        defaultMessage: "The card's debt is fully covered by money set aside. When you pay the card from the checking account, the payment counts against it.",
      });
    }
    if (hasStartingBalance) {
      return intl.formatMessage({
        id: "budget.payment.uncoveredStartingBalance",
        defaultMessage:
          "Some of this debt was already there when you added the card — its starting balance. It does not come from new spending, so it takes nothing from unassigned money. Assign money to this category a bit at a time to cover it.",
      });
    }
    if (overspendingBy && overspendingBy.length > 0) {
      const names = new Intl.ListFormat(intl.locale, { style: "long", type: "conjunction" }).format(
        overspendingBy.map((o) => `${o.name} (${money(o.amount)})`),
      );
      return intl.formatMessage(
        {
          id: "budget.payment.uncoveredFromCategories",
          defaultMessage:
            "The uncovered debt comes from card spending beyond what was available: {categories}. Covering those categories by the end of the month sends the money here; otherwise they restart at zero next month and the debt stays here to cover.",
        },
        { categories: names },
      );
    }
    return intl.formatMessage({
      id: "budget.payment.uncovered",
      defaultMessage: "Some of the card's debt has no money set aside yet: assign money to this category to cover it.",
    });
  }

  return (
    <DetailFrame
      label={intl.formatMessage({ id: "budget.row.detailLabel", defaultMessage: "Detail for {category}" }, { category: categoryName })}
      fullScreen={fullScreen ?? false}
      onClose={onClose}
    >
      <div className="sec">
        <span className="state-l">{intl.formatMessage({ id: "budget.payment.setAside", defaultMessage: "Set aside to pay the card" })}</span>
        <span className="big n">{money(available)}</span>
        <p className="explain">{explanation()}</p>
      </div>

      {!covered && (
        <div className="sec">
          <div className="qa static">
            <span>{intl.formatMessage({ id: "budget.payment.cardBalance", defaultMessage: "Card balance" })}</span>
            <span className="dots" />
            <span className="n">{money(debt)}</span>
          </div>
          <div className="qa static">
            <span>{intl.formatMessage({ id: "budget.payment.setAsideLine", defaultMessage: "Set aside" })}</span>
            <span className="dots" />
            <span className="n">{money(Math.max(0, available))}</span>
          </div>
          <div className="qa static">
            <span>{intl.formatMessage({ id: "budget.payment.toCover", defaultMessage: "To cover" })}</span>
            <span className="dots" />
            <span className="n warnl">{money(uncovered)}</span>
          </div>
          {!readOnly && (
            <>
              <button type="button" className="plain" onClick={onAssignFromUnassigned}>
                {intl.formatMessage({ id: "budget.payment.assignFromUnassigned", defaultMessage: "Assign {amount} from unassigned money" }, { amount: money(uncovered) })}
              </button>
              <button type="button" className="plain" onClick={onMoveMoneyHere}>
                {intl.formatMessage({ id: "budget.payment.moveMoneyHere", defaultMessage: "Move money here" })}
              </button>
            </>
          )}
        </div>
      )}
    </DetailFrame>
  );
}
