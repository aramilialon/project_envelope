import { formatMoney } from "@envelope/core";
import { useIntl } from "react-intl";

import "./RowDetail.css";

interface Props {
  readonly categoryName: string;
  /** Money set aside to pay the card — `BudgetGroupCategory.available`. */
  readonly available: number;
  /** How much of the card's real balance no assigned money covers yet. */
  readonly uncovered: number;
  readonly currency: string;
  onClose(): void;
  /** "Assign €X from unassigned money": opens the move-money form with the source forced to unassigned. */
  onAssignFromUnassigned(): void;
  /** "Move money here": opens the move-money form with no source forced — any category can cover it. */
  onMoveMoneyHere(): void;
}

/**
 * A card's own payment category detail, opening in its own row exactly like an ordinary
 * category's (`RowDetail.tsx`, #327) — design.md's "Card payment category": money set aside, a
 * sentence about the card's debt, the debt itself (balance, set aside, to cover) when any of it
 * is uncovered, and the two actions #328's `MoveMoneyForm` already provides (reused here, not a
 * separate one-click commit the way the reference mockup's own shortcut button does). The
 * mockup's own two more specific sentences — the starting balance's own amount and date, or the
 * exact categories whose card spending caused it — need data this API does not expose yet (which
 * categories' credit overspending happened on *this* card specifically, with more than one credit
 * card in the workspace): a generic sentence stands in until a later issue adds it.
 *
 * The month's own ledger, assignment history and transaction history (the rest of design.md's
 * own three-column list for this row) are deliberately not built here, the same way #327 left
 * them out of an ordinary category's own detail — no issue has fetched that data yet.
 */
export default function PaymentCategoryDetail({ categoryName, available, uncovered, currency, onClose, onAssignFromUnassigned, onMoveMoneyHere }: Props) {
  const intl = useIntl();
  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency });
  const covered = uncovered <= 0;
  const debt = covered ? 0 : available + uncovered;

  return (
    <div className="inl" role="region" aria-label={intl.formatMessage({ id: "budget.row.detailLabel", defaultMessage: "Detail for {category}" }, { category: categoryName })}>
      <button type="button" className="plain closer" onClick={onClose}>
        {intl.formatMessage({ id: "common.action.close", defaultMessage: "× Close" })}
      </button>
      <div className="inl-c">
        <div className="sec">
          <span className="state-l">{intl.formatMessage({ id: "budget.payment.setAside", defaultMessage: "Set aside to pay the card" })}</span>
          <span className="big n">{money(available)}</span>
          <p className="explain">
            {covered
              ? intl.formatMessage({
                  id: "budget.payment.covered",
                  defaultMessage: "The card's debt is fully covered by money set aside. When you pay the card from the checking account, the payment counts against it.",
                })
              : intl.formatMessage({
                  id: "budget.payment.uncovered",
                  defaultMessage: "Some of the card's debt has no money set aside yet: assign money to this category to cover it.",
                })}
          </p>
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
            <button type="button" className="plain" onClick={onAssignFromUnassigned}>
              {intl.formatMessage({ id: "budget.payment.assignFromUnassigned", defaultMessage: "Assign {amount} from unassigned money" }, { amount: money(uncovered) })}
            </button>
            <button type="button" className="plain" onClick={onMoveMoneyHere}>
              {intl.formatMessage({ id: "budget.payment.moveMoneyHere", defaultMessage: "Move money here" })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
