import { cardDebt, formatMoney } from "@envelope/core";
import { useIntl } from "react-intl";

import { cardPartAskedSentence } from "./cardPartAsked.ts";
import DetailFrame from "./DetailFrame.tsx";
import "./RowDetail.css";

interface Props {
  readonly categoryName: string;
  /** The payment category's own available amount — `BudgetGroupCategory.available`; negative when the card was paid beyond what was set aside, or is in credit. */
  readonly available: number;
  /** The payment category's cash overspending — `BudgetGroupCategory.cashOverspending`: what was paid beyond what was set aside and beyond the card's credit (#660). */
  readonly cashOverspending: number;
  /** How much of the card's real balance no assigned money covers yet. */
  readonly uncovered: number;
  /** The card's real debt, what is owed on it (#699) — `BudgetGroupCategory.owed`; undefined when the API does not know it. */
  readonly owed: number | undefined;
  /** Whether the card had a starting balance when added (#355) — picks the specific "already had debt" sentence over the generic one. */
  readonly hasStartingBalance?: boolean;
  /** Which ordinary categories' credit overspending this month is attributable to this card, with their own names and amounts (#355). */
  readonly overspendingBy?: readonly { readonly categoryId: string; readonly name: string; readonly amount: number }[];
  /**
   * The part of the card's debt asked on ordinary categories instead (#731, `@envelope/core`'s
   * `cardPartsAskedOnCategories`), with their names: "Assign" offers the rest only
   * (`cardAmountAsked`), while "To cover" keeps the whole debt.
   */
  readonly askedOnCategories?: readonly { readonly categoryId: string; readonly name: string; readonly amountCents: number }[];
  readonly currency: string;
  onClose(): void;
  /** "Assign €X from unassigned money": opens the move-money form with the source forced to unassigned. */
  onAssignFromUnassigned(): void;
  /** "Move money here": opens the move-money form with no source forced — any category can cover it. */
  onMoveMoneyHere(): void;
  /** Full screen with a back link, not inline under the row (the phone layout, `#331`). */
  readonly fullScreen?: boolean;
  /** Brings the detail into view and focuses its heading when it changes (`DetailFrame`'s own `focusRequest`, #728). */
  readonly focusRequest?: string | number | undefined;
  /** A `read_only` member (#61, design.md: "resolving any of these needs the owner or editor role") still sees this detail, just not its own two actions. */
  readonly readOnly?: boolean;
}

/**
 * A card's own payment category detail, opening in its own row exactly like an ordinary
 * category's (`RowDetail.tsx`, #327) — design.md's "Card payment category": money set aside, a
 * sentence about the card's debt, the debt itself (balance, set aside, what was paid beyond what
 * was set aside when the card was, to cover) when any of it is uncovered — every figure from
 * `@envelope/core`'s `cardDebt` (#699), none derived here — and the two actions #328's `MoveMoneyForm` already provides (reused here, not a
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
  cashOverspending,
  uncovered,
  owed,
  hasStartingBalance,
  overspendingBy,
  askedOnCategories,
  currency,
  onClose,
  onAssignFromUnassigned,
  onMoveMoneyHere,
  fullScreen,
  focusRequest,
  readOnly,
}: Props) {
  const intl = useIntl();
  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency });
  const debt = cardDebt({ available, cashOverspending, uncovered, ...(owed !== undefined ? { owed } : {}) });
  const covered = debt.toCover <= 0;
  // #731: what assigning here asks — the card's to cover less what is asked on categories for it,
  // the same figure as its "To do" item (`cardAmountAsked`); the meter keeps the whole to cover.
  const asked = askedOnCategories ?? [];
  const assignAmount = Math.max(0, debt.toCover - asked.reduce((sum, p) => sum + p.amountCents, 0));
  /** The card's credit, when it has one (#660): what the card owes the user, `-owed`. */
  const credit = Math.max(0, -debt.owed);
  const inCredit = credit > 0;

  /**
   * The sentences above the debt (#699): what was paid beyond what was set aside first, when the
   * card was, then where the uncovered debt comes from, when any is. Whole messages only, one per
   * paragraph, never joined in code.
   */
  function explanation(): readonly string[] {
    if (covered) {
      // A card in credit has nothing to cover, but nothing set aside covers anything either: it
      // must not read "fully covered by money set aside" (#660).
      if (inCredit) {
        return [
          intl.formatMessage(
            {
              id: "budget.payment.inCredit",
              defaultMessage: "The card is in credit by {credit}. Card spending uses up this credit first; there is nothing to cover.",
            },
            { credit: money(credit) },
          ),
        ];
      }
      // A card known to owe nothing has no debt for money set aside to cover (#660).
      if (owed === 0) {
        return [
          intl.formatMessage({
            id: "budget.payment.noDebt",
            defaultMessage: "The card owes nothing right now; there is nothing to cover.",
          }),
        ];
      }
      return [
        intl.formatMessage({
          id: "budget.payment.covered",
          defaultMessage: "The card's debt is fully covered by money set aside. When you pay the card from the checking account, the payment counts against it.",
        }),
      ];
    }
    const sentences: string[] = [];
    const paidBeyond = debt.paidBeyondSetAside > 0;
    if (paidBeyond && inCredit) {
      // Part of what was paid beyond is still on the card as its credit; only the rest is to
      // cover (#660). The consequence is stated, not given as an order (#771).
      sentences.push(
        intl.formatMessage(
          {
            id: "budget.payment.paidBeyondInCreditExplanation",
            defaultMessage:
              "The card was paid {paidBeyondTotal} more than was set aside. {credit} of it is still on the card as credit. If the other {paidBeyond} is still uncovered when the month ends, it comes out of next month's unassigned money.",
          },
          { paidBeyondTotal: money(-available), credit: money(credit), paidBeyond: money(debt.paidBeyondSetAside) },
        ),
      );
    } else if (paidBeyond) {
      sentences.push(
        intl.formatMessage(
          {
            id: "budget.payment.paidBeyondExplanation",
            defaultMessage:
              "The card was paid {paidBeyond} more than was set aside for it. Cover it here this month, or it comes out of next month's unassigned money.",
          },
          { paidBeyond: money(debt.paidBeyondSetAside) },
        ),
      );
    }
    if (debt.uncovered > 0) {
      sentences.push(uncoveredExplanation(paidBeyond));
    }
    return sentences;
  }

  function uncoveredExplanation(afterPaidBeyond: boolean): string {
    if (hasStartingBalance) {
      // After the paid-beyond sentence, "it takes nothing from unassigned money" would read as
      // contradicting it: that part does come out of next month's unassigned money.
      return afterPaidBeyond
        ? intl.formatMessage({
            id: "budget.payment.uncoveredStartingBalanceAfterPaidBeyond",
            defaultMessage:
              "Some of this debt was already there when you added the card — its starting balance. Assign money to this category a bit at a time to cover it.",
          })
        : intl.formatMessage({
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
            "The uncovered debt comes from card spending beyond what was available: {categories}. It stays here to cover until money is assigned to it.",
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
      focusRequest={focusRequest}
      onClose={onClose}
    >
      {/* The card's own name, the same heading an ordinary category's detail has (#728): the focus target when the detail is opened from elsewhere. */}
      <div className="det-h">
        <h3 tabIndex={-1}>{categoryName}</h3>
      </div>
      <div className="sec">
        <span className="state-l">{intl.formatMessage({ id: "budget.payment.setAside", defaultMessage: "Set aside to pay the card" })}</span>
        <span className="big n">{money(debt.setAside)}</span>
        {explanation().map((sentence) => (
          <p key={sentence} className="explain">
            {sentence}
          </p>
        ))}
      </div>

      {!covered && (
        <div className="sec">
          {/* A card in credit shows its credit as a positive line in the balance's place, never a negative balance (#660). */}
          {inCredit ? (
            <div className="qa static">
              <span>{intl.formatMessage({ id: "budget.payment.cardCredit", defaultMessage: "Credit on the card" })}</span>
              <span className="dots" />
              <span className="n">{money(credit)}</span>
            </div>
          ) : (
            <div className="qa static">
              <span>{intl.formatMessage({ id: "budget.payment.cardBalance", defaultMessage: "Card balance" })}</span>
              <span className="dots" />
              <span className="n">{money(debt.owed)}</span>
            </div>
          )}
          <div className="qa static">
            <span>{intl.formatMessage({ id: "budget.payment.setAsideLine", defaultMessage: "Set aside" })}</span>
            <span className="dots" />
            <span className="n">{money(debt.setAside)}</span>
          </div>
          {debt.paidBeyondSetAside > 0 && (
            <div className="qa static">
              <span>{intl.formatMessage({ id: "budget.payment.paidBeyondSetAside", defaultMessage: "Paid beyond what was set aside" })}</span>
              <span className="dots" />
              <span className="n">{money(debt.paidBeyondSetAside)}</span>
            </div>
          )}
          <div className="qa static">
            <span>{intl.formatMessage({ id: "budget.payment.toCover", defaultMessage: "To cover" })}</span>
            <span className="dots" />
            <span className="n warnl">{money(debt.toCover)}</span>
          </div>
          {asked.length > 0 && (
            <p className="explain">{cardPartAskedSentence(intl, money, asked, (id) => asked.find((p) => p.categoryId === id)?.name ?? "")}</p>
          )}
          {!readOnly && (
            <>
              {assignAmount > 0 && (
                <button type="button" className="plain" onClick={onAssignFromUnassigned}>
                  {intl.formatMessage({ id: "budget.payment.assignFromUnassigned", defaultMessage: "Assign {amount} from unassigned money" }, { amount: money(assignAmount) })}
                </button>
              )}
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
