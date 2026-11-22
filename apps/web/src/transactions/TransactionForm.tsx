import { availableAfterInflow, currencyDecimals, incomeReceived, formatMoney, MAX_FREE_TEXT_LENGTH, monthOf, parseAmount, transferCategoryRule, type TransferCategoryRule } from "@envelope/core";
import { useState, type FormEvent } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import type { Account } from "../accounts/api.ts";
import type { Category } from "../categories/api.ts";
import { getBudgetMonth } from "../budget/api.ts";
import SideSheet from "../layout/SideSheet.tsx";
import { isAccountClosed, tooManyRequestsMessage } from "../apiErrors.ts";
import { ApiError } from "../apiFetch.ts";
import { amountTooLargeMessage, isAmountTooLarge } from "../amountTooLarge.ts";
import { shortDate } from "../format.ts";
import { useFetchState } from "../useFetchState.ts";
import {
  createTransaction,
  createTransfer,
  deleteTransaction,
  updateTransaction,
  type SplitInput,
  type Transaction,
  type UpdateTransactionInput,
} from "./api.ts";
import { accountClosedAddMessage, accountClosedChangeMessage, accountClosedDeleteMessage, closedAccountOf } from "./accountClosedMessages.ts";
import { totalOf } from "./transactionAmount.ts";
import "./TransactionForm.css";

type Kind = "out" | "in" | "transfer";

/** A transfer's direction, seen from this account: "To another account" or "From another account" (#599). */
type Direction = "out" | "in";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface SplitLine {
  categoryId: string;
  amountStr: string;
}

interface Props {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly accounts: readonly Account[];
  readonly categories: readonly Category[];
  readonly currency: string;
  /** "Today" in the workspace's own time zone (#326), never the browser's — a new transaction's default date. */
  readonly today: string;
  /** Absent creates a new transaction; given, edits that one. */
  readonly transaction?: Transaction;
  onClose(): void;
  onSaved(): void;
}

function kindOf(transaction: Transaction | undefined): Kind {
  if (!transaction) return "out";
  if (transaction.transferId !== null) return "transfer";
  return totalOf(transaction) < 0 ? "out" : "in";
}

/** Whether `splits` are the transaction's own splits, same categories and amounts in the same order. */
function sameSplits(splits: readonly SplitInput[], original: Transaction): boolean {
  return (
    splits.length === original.splits.length &&
    splits.every((s, i) => s.categoryId === (original.splits[i]!.categoryId ?? null) && s.amountCents === original.splits[i]!.amountCents)
  );
}

function endOf(account: Account): { onBudget: boolean; creditCard: boolean } {
  return { onBudget: account.onBudget, creditCard: account.type === "credit_card" };
}

/** An amount in minor units as the amount field shows it, with the currency's own number of decimals (#652: none for JPY, three for KWD). */
function centsToInput(cents: number, locale: string, currency: string): string {
  const decimals = currencyDecimals(currency);
  return (cents / 10 ** decimals).toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * The register's "+ New transaction" / "edit a row" side panel (#54): outflow, inflow or
 * transfer, splitting an outflow across categories. An existing transaction's date cannot be
 * changed here yet, only at creation: the API takes a new `occurredAt` since #655, and this form
 * gains it with #656. A transfer goes "To another account" or comes "From another account" (#599; credit
 * cards are not offered as a source). When exactly one of the two accounts is off budget, the
 * on-budget leg's category follows `@envelope/core`'s `transferCategoryRule`: required when the
 * money leaves the budget or comes into an on-budget card, optional from an off-budget account
 * into a cash account, where "Unassigned" (no category: income to assign) comes first and is the
 * default, with a hint saying how much "Unassigned" (or the chosen category) goes from and to in
 * the month of the transfer's date, or, dated after today, the day the money comes in. Editing
 * an existing transfer leg is limited to its payee, memo, cleared status and, on such an on-budget leg, its category (cleared back to "Unassigned" only
 * where the rule allows it): the form sends a category change as the leg's one split with its
 * own amount, so the other leg is left alone; the amount and the other account are set only at
 * creation (the API would move the other leg's amount too, #547, but the mockup has no amount
 * edit for a transfer). "Delete" (`#403`, the mockup's own `data-delete`) removes an
 * existing transaction outright — both legs together for a transfer, `apps/api`'s own
 * `deleteTransaction` handles that, not this form. A reconciled transaction is never handed to
 * this form — `AccountRegisterScreen` shows it read-only instead, with its own "Unlock" action.
 */
export default function TransactionForm({ workspaceId, accountId, accounts, categories, currency, today, transaction, onClose, onSaved }: Props) {
  const intl = useIntl();
  const auth = useAuth();
  const isEditing = transaction !== undefined;
  const isTransferLeg = transaction !== undefined && transaction.transferId !== null;

  const [kind, setKind] = useState<Kind>(kindOf(transaction));
  const [date, setDate] = useState(transaction?.budgetDate ?? today);
  const [amountStr, setAmountStr] = useState(transaction ? centsToInput(Math.abs(totalOf(transaction)), intl.locale, currency) : "");
  const [payee, setPayee] = useState(transaction?.payee ?? "");
  const [memo, setMemo] = useState(transaction?.memo ?? "");
  const [cleared, setCleared] = useState(transaction ? transaction.status !== "pending" : false);
  // On a transfer leg, "" is "Unassigned" where the category is optional and "no choice yet"
  // where it is required; a leg with no category reads back as "".
  const [categoryId, setCategoryId] = useState(transaction?.splits.length === 1 ? (transaction.splits[0]!.categoryId ?? "") : "");
  const [split, setSplit] = useState(!isTransferLeg && (transaction?.splits.length ?? 0) > 1);
  const [lines, setLines] = useState<SplitLine[]>(
    !isTransferLeg && (transaction?.splits.length ?? 0) > 1
      ? transaction!.splits.map((s) => ({ categoryId: s.categoryId ?? "", amountStr: centsToInput(Math.abs(s.amountCents), intl.locale, currency) }))
      : [{ categoryId: "", amountStr: "" }, { categoryId: "", amountStr: "" }],
  );
  const [direction, setDirection] = useState<Direction>(isTransferLeg && totalOf(transaction) > 0 ? "in" : "out");
  /** The other account of the transfer: its destination going out, its source coming in. */
  const [otherAccountId, setOtherAccountId] = useState(isTransferLeg ? (transaction.transferAccountId ?? "") : "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // "From another account" leaves credit cards out: money coming from a card (a cash advance) is
  // not covered yet (design.md, "Account register"). An edited leg keeps its own account listed.
  // Only accounts in this account's own currency: a transfer never crosses currencies (#652). A
  // closed account takes no transfer (#729).
  const ownCurrency = accounts.find((a) => a.id === accountId)?.currency;
  const otherAccounts = accounts.filter(
    (a) =>
      a.id !== accountId &&
      (a.closedAt === null || a.id === transaction?.transferAccountId) &&
      (ownCurrency === undefined || a.currency === ownCurrency || a.id === transaction?.transferAccountId) &&
      (direction === "out" || a.type !== "credit_card" || a.id === transaction?.transferAccountId),
  );
  // A card's own payment category is never a valid choice here (#386) — `packages/core` accepts
  // one as an ordinary Activity.categoryId only for the system-generated starting-balance split,
  // never a category the user picks by hand.
  const paymentCategoryIds = new Set(accounts.map((a) => a.paymentCategoryId).filter((id): id is string => id !== null));
  const openCategories = categories.filter((c) => !c.archived && !paymentCategoryIds.has(c.id));

  // design.md, "Account register": a transfer with an off-budget account moves money into or out
  // of the budget, so its on-budget leg's category follows `transferCategoryRule` (#378, #598):
  // whichever of the two accounts is on budget, since the category lands on that leg. On an
  // existing leg, only the on-budget one has a category to edit.
  const currentAccount = accounts.find((a) => a.id === accountId);
  const otherAccount = accounts.find((a) => a.id === otherAccountId);
  const transferRuleOfAccounts: TransferCategoryRule =
    currentAccount !== undefined && otherAccount !== undefined && (!isEditing || currentAccount.onBudget)
      ? direction === "out"
        ? transferCategoryRule(endOf(currentAccount), endOf(otherAccount))
        : transferCategoryRule(endOf(otherAccount), endOf(currentAccount))
      : "none";
  const transferRule: TransferCategoryRule = kind === "transfer" ? transferRuleOfAccounts : "none";
  /** The money comes into the budget from an off-budget account: what "Unassigned" or the category goes from and to is worth showing. */
  const moneyEntersBudget =
    transferRule !== "none" && currentAccount !== undefined && otherAccount !== undefined && (direction === "out" ? !currentAccount.onBudget : !otherAccount.onBudget);
  const originalCategoryId = isTransferLeg && transaction.splits.length === 1 ? (transaction.splits[0]!.categoryId ?? "") : "";

  // The budget month the money lands in (the month of the transfer's date): what "Unassigned" and
  // each category hold before it, for the option's amount and the hint. Fetched only for such a
  // transfer; while it loads, or if it fails, both are left out.
  const budgetMonthOf = moneyEntersBudget && ISO_DATE.test(date) ? monthOf(date) : undefined;
  const accessToken = auth.user?.access_token;
  const budget = useFetchState(
    () => (accessToken && budgetMonthOf ? getBudgetMonth(accessToken, workspaceId, budgetMonthOf).then((budgetMonth) => ({ budgetMonth })) : undefined),
    [accessToken, workspaceId, budgetMonthOf],
    { resetOnDepsChange: true },
  );
  const budgetMonth = budget.status === "ok" && budgetMonthOf !== undefined ? budget.budgetMonth : undefined;

  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency });

  /** "The money comes into the budget: … goes from X to Y." (or, with a date after today, the day it comes into "Unassigned" or the category, #700, #668) — for a new transfer, or an edited leg whose category changes (the leg already counts where it is). */
  function inflowHint(): string | null {
    if (!moneyEntersBudget || (isEditing && categoryId === originalCategoryId)) {
      return null;
    }
    let amount: number;
    try {
      amount = isTransferLeg ? Math.abs(totalOf(transaction)) : parseAmount(amountStr, { locale: intl.locale, currency });
    } catch {
      return null;
    }
    if (!(amount > 0)) {
      return null;
    }
    if (categoryId === "") {
      if (transferRule !== "optional") {
        return null;
      }
      // Income counts from its own date on (#650): money dated after today leaves "Unassigned" as it
      // is until then (#700). Saying so needs no amounts, so it shows before the budget month loads,
      // and even if that fails.
      if (ISO_DATE.test(date) && !incomeReceived(date, today)) {
        return intl.formatMessage(
          { id: "transactions.form.inflowHint.unassignedLater", defaultMessage: "The money comes into “Unassigned” on {date}." },
          { date: shortDate(date, intl.locale) },
        );
      }
      if (!budgetMonth) {
        return null;
      }
      const change = availableAfterInflow(budgetMonth.unassigned, amount, { date, today });
      if (!change.received) {
        return null;
      }
      return intl.formatMessage(
        { id: "transactions.form.inflowHint.unassigned", defaultMessage: "The money comes into the budget: “Unassigned” goes from {from} to {to}." },
        { from: money(change.fromCents), to: money(change.toCents) },
      );
    }
    // Into a category too, money dated after today counts nowhere until its date (#668): the
    // category stays as it is until then. Like "Unassigned" above, saying so needs no amounts.
    const chosen = categories.find((c) => c.id === categoryId);
    if (chosen && ISO_DATE.test(date) && !incomeReceived(date, today)) {
      return intl.formatMessage(
        { id: "transactions.form.inflowHint.categoryLater", defaultMessage: "The money comes into {category} on {date}." },
        { category: chosen.name, date: shortDate(date, intl.locale) },
      );
    }
    const category = budgetMonth?.categories.find((c) => c.categoryId === categoryId);
    if (!category) {
      return null;
    }
    const change = availableAfterInflow(category.available, amount, { date, today });
    if (!change.received) {
      return null;
    }
    return intl.formatMessage(
      { id: "transactions.form.inflowHint.category", defaultMessage: "The money comes into the budget: {category} goes from {from} to {to}." },
      { category: category.name, from: money(change.fromCents), to: money(change.toCents) },
    );
  }

  function changeKind(next: Kind) {
    setKind(next);
    // A split belongs to an outflow: every kind change starts back without one (the mockup), so a
    // split left on never hides a transfer's or an inflow's category.
    setSplit(false);
    // Into a transfer from an off-budget account to a cash account, the category starts back at "Unassigned" (the mockup).
    if (next === "transfer" && transferRuleOfAccounts === "optional") {
      setCategoryId("");
    }
  }

  function changeDirection(next: Direction) {
    setDirection(next);
    // A message about the other direction's choices no longer applies.
    setError(null);
    // Switching direction keeps the account already chosen, except a card as the source.
    if (next === "in" && otherAccount?.type === "credit_card") {
      setOtherAccountId("");
    }
  }

  function changeOtherAccount(next: string) {
    setOtherAccountId(next);
    // The category rule may have changed with the account: a stale "Choose a category." goes.
    setError(null);
  }

  function parsePositive(text: string): number {
    const amount = parseAmount(text, { locale: intl.locale, currency });
    if (amount <= 0) {
      throw new Error("not positive");
    }
    return amount;
  }

  function addLine() {
    setLines((current) => [...current, { categoryId: "", amountStr: "" }]);
  }

  function removeLine(index: number) {
    setLines((current) => current.filter((_, i) => i !== index));
  }

  function updateLine(index: number, patch: Partial<SplitLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  /**
   * On edit, only the fields the user changed (#507): an imported payee or memo can be longer than
   * the API accepts from a form, and re-sending it unchanged would make every other edit of that
   * transaction fail. A cleared field is not sent, as before.
   */
  function editedFields(original: Transaction): UpdateTransactionInput {
    const status = cleared ? "cleared" : "pending";
    return {
      ...(payee && payee !== (original.payee ?? "") ? { payee } : {}),
      ...(memo && memo !== (original.memo ?? "") ? { memo } : {}),
      ...(status !== original.status ? { status } : {}),
    };
  }

  async function saveChanges(original: Transaction, changes: UpdateTransactionInput): Promise<void> {
    const accessToken = auth.user?.access_token;
    if (!accessToken || Object.keys(changes).length === 0) {
      return;
    }
    await updateTransaction(accessToken, workspaceId, accountId, original.id, changes);
  }

  function saveErrorMessage(caught: unknown): string {
    const limited = tooManyRequestsMessage(intl, caught);
    if (limited) {
      return limited;
    }
    // A split line typed above the cap, or the API refusing an amount above it (#651).
    if (isAmountTooLarge(caught)) {
      return amountTooLargeMessage(intl, currency);
    }
    if (caught instanceof ApiError && caught.code === "text_too_long") {
      const max = Number(caught.details.max);
      switch (caught.details.field) {
        case "payee":
          return intl.formatMessage(
            { id: "transactions.form.payeeTooLong", defaultMessage: "The payee is too long: it can have up to {max} characters." },
            { max },
          );
        case "memo":
          return intl.formatMessage(
            { id: "transactions.form.memoTooLong", defaultMessage: "The memo is too long: it can have up to {max} characters." },
            { max },
          );
        default:
          return intl.formatMessage(
            { id: "transactions.form.textTooLong", defaultMessage: "A text is too long: it can have up to {max} characters." },
            { max },
          );
      }
    }
    if (isAccountClosed(caught)) {
      return accountClosedMessage("save");
    }
    if (caught instanceof ApiError && caught.code === "card_income_not_supported") {
      // #548: income (an inflow with no category) on an on-budget credit card is not supported yet.
      return intl.formatMessage({
        id: "transactions.form.cardIncomeNotSupported",
        defaultMessage: "Income on a credit card is not supported yet: choose a category for this inflow.",
      });
    }
    return intl.formatMessage({ id: "transactions.form.error", defaultMessage: "We could not save this transaction." });
  }

  /**
   * A write refused because an account is closed (#729, #741): this account's own, reached only
   * by its address since a closed account's register is not linked, or more often a transfer's
   * other account, closed after the transfer was entered or after this form opened. A new
   * transaction "can't be added"; an existing one "can't be changed" or "can't be deleted".
   */
  function accountClosedMessage(write: "save" | "delete"): string {
    const ownClosed = accounts.some((a) => a.id === accountId && a.closedAt !== null);
    if (!isEditing) {
      const isTransfer = kind === "transfer";
      return accountClosedAddMessage(intl, closedAccountOf(ownClosed, isTransfer), isTransfer);
    }
    const closed = closedAccountOf(ownClosed, isTransferLeg);
    return write === "save" ? accountClosedChangeMessage(intl, closed) : accountClosedDeleteMessage(intl, closed);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    setError(null);

    let amount: number;
    try {
      amount = parsePositive(amountStr);
    } catch (caught) {
      setError(
        isAmountTooLarge(caught)
          ? amountTooLargeMessage(intl, currency)
          : intl.formatMessage({ id: "transactions.form.invalidAmount", defaultMessage: "Enter an amount greater than zero." }),
      );
      return;
    }

    setSubmitting(true);
    try {
      if (kind === "transfer") {
        if (isEditing) {
          if (transferRule === "required" && !categoryId) {
            setError(intl.formatMessage({ id: "transactions.form.chooseCategory", defaultMessage: "Choose a category." }));
            setSubmitting(false);
            return;
          }
          const legTotal = totalOf(transaction);
          const categoryChanged = transferRule !== "none" && categoryId !== originalCategoryId;
          await saveChanges(transaction, {
            ...editedFields(transaction),
            ...(categoryChanged ? { splits: [{ categoryId: categoryId || null, amountCents: legTotal }], amountCents: legTotal } : {}),
          });
        } else {
          if (!otherAccountId) {
            setError(
              direction === "in"
                ? intl.formatMessage({ id: "transactions.form.chooseSource", defaultMessage: "Choose a source account." })
                : intl.formatMessage({ id: "transactions.form.chooseDestination", defaultMessage: "Choose a destination account." }),
            );
            setSubmitting(false);
            return;
          }
          if (transferRule === "required" && !categoryId) {
            setError(intl.formatMessage({ id: "transactions.form.chooseCategory", defaultMessage: "Choose a category." }));
            setSubmitting(false);
            return;
          }
          await createTransfer(accessToken, workspaceId, {
            sourceAccountId: direction === "out" ? accountId : otherAccountId,
            destinationAccountId: direction === "out" ? otherAccountId : accountId,
            occurredAt: date,
            amountCents: amount,
            ...(payee ? { payee } : {}),
            ...(memo ? { memo } : {}),
            // No category on an optional one leaves the money "Unassigned", income to assign.
            ...(transferRule !== "none" && categoryId ? { categoryId } : {}),
            status: cleared ? "cleared" : "pending",
          });
        }
      } else {
        let splits: SplitInput[];
        if (split) {
          let lineTotal = 0;
          splits = [];
          for (const line of lines) {
            if (!line.categoryId || !line.amountStr.trim()) {
              continue;
            }
            const lineAmount = parsePositive(line.amountStr);
            lineTotal += lineAmount;
            splits.push({ categoryId: line.categoryId, amountCents: kind === "out" ? -lineAmount : lineAmount });
          }
          if (splits.length < 2) {
            setError(intl.formatMessage({ id: "transactions.form.needTwoLines", defaultMessage: "Add at least two split lines." }));
            setSubmitting(false);
            return;
          }
          if (lineTotal !== amount) {
            setError(
              intl.formatMessage(
                { id: "transactions.form.splitMismatch", defaultMessage: "The split lines add up to {total}, not {amount}." },
                { total: formatMoney(lineTotal, { locale: intl.locale, currency }), amount: formatMoney(amount, { locale: intl.locale, currency }) },
              ),
            );
            setSubmitting(false);
            return;
          }
        } else {
          if (kind === "out" && !categoryId) {
            setError(intl.formatMessage({ id: "transactions.form.chooseCategory", defaultMessage: "Choose a category." }));
            setSubmitting(false);
            return;
          }
          splits = [{ categoryId: categoryId || null, amountCents: kind === "out" ? -amount : amount }];
        }
        const amountCents = splits.reduce((sum, s) => sum + s.amountCents, 0);

        if (isEditing) {
          await saveChanges(transaction, {
            ...editedFields(transaction),
            ...(sameSplits(splits, transaction) ? {} : { splits, amountCents }),
          });
        } else {
          await createTransaction(accessToken, workspaceId, accountId, {
            occurredAt: date,
            ...(payee ? { payee } : {}),
            ...(memo ? { memo } : {}),
            status: cleared ? "cleared" : "pending",
            splits,
          });
        }
      }
      onSaved();
    } catch (caught) {
      setError(saveErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    const accessToken = auth.user?.access_token;
    if (!accessToken || !transaction) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await deleteTransaction(accessToken, workspaceId, accountId, transaction.id);
      onSaved();
    } catch (caught) {
      setError(
        tooManyRequestsMessage(intl, caught) ??
          (isAccountClosed(caught)
            ? accountClosedMessage("delete")
            : intl.formatMessage({ id: "transactions.form.deleteError", defaultMessage: "We could not delete this transaction." })),
      );
      setSubmitting(false);
    }
  }

  const hint = inflowHint();

  // Separate literal calls, not one call with a chosen descriptor, so the extractor sees both ids.
  const title = isEditing
    ? intl.formatMessage({ id: "transactions.form.editTitle", defaultMessage: "Edit transaction" })
    : intl.formatMessage({ id: "transactions.form.newTitle", defaultMessage: "New transaction" });

  return (
    <SideSheet title={title} onClose={onClose}>
      <form className="transaction-form" onSubmit={(event) => void handleSubmit(event)}>
        <fieldset className="segs" disabled={isEditing}>
          <legend className="sr-only">{intl.formatMessage({ id: "transactions.form.kind", defaultMessage: "Kind" })}</legend>
          <label>
            <input type="radio" name="kind" checked={kind === "out"} onChange={() => changeKind("out")} />
            <span>{intl.formatMessage({ id: "transactions.form.kind.out", defaultMessage: "Outflow" })}</span>
          </label>
          <label>
            <input type="radio" name="kind" checked={kind === "in"} onChange={() => changeKind("in")} />
            <span>{intl.formatMessage({ id: "transactions.form.kind.in", defaultMessage: "Inflow" })}</span>
          </label>
          <label>
            <input type="radio" name="kind" checked={kind === "transfer"} onChange={() => changeKind("transfer")} />
            <span>{intl.formatMessage({ id: "transactions.form.kind.transfer", defaultMessage: "Transfer" })}</span>
          </label>
        </fieldset>

        <div className="two">
          <div className="field">
            <label htmlFor="tx-date">{intl.formatMessage({ id: "transactions.form.date", defaultMessage: "Date" })}</label>
            <input
              id="tx-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              disabled={isEditing}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="tx-amount">{intl.formatMessage({ id: "transactions.form.amount", defaultMessage: "Amount" })}</label>
            <input
              id="tx-amount"
              type="text"
              inputMode="decimal"
              value={amountStr}
              disabled={isTransferLeg}
              onChange={(event) => setAmountStr(event.target.value)}
              placeholder="0.00"
            />
          </div>
        </div>

        {kind === "transfer" && (
          <>
            <fieldset className="segs" disabled={isEditing}>
              <legend className="sr-only">{intl.formatMessage({ id: "transactions.form.direction", defaultMessage: "Direction" })}</legend>
              <label>
                <input type="radio" name="direction" checked={direction === "out"} onChange={() => changeDirection("out")} />
                <span>{intl.formatMessage({ id: "transactions.form.direction.out", defaultMessage: "To another account" })}</span>
              </label>
              <label>
                <input type="radio" name="direction" checked={direction === "in"} onChange={() => changeDirection("in")} />
                <span>{intl.formatMessage({ id: "transactions.form.direction.in", defaultMessage: "From another account" })}</span>
              </label>
            </fieldset>
            <div className="field">
              <label htmlFor="tx-other-account">
                {direction === "in"
                  ? intl.formatMessage({ id: "transactions.form.source", defaultMessage: "From account" })
                  : intl.formatMessage({ id: "transactions.form.destination", defaultMessage: "To account" })}
              </label>
              <select id="tx-other-account" value={otherAccountId} disabled={isEditing} onChange={(event) => changeOtherAccount(event.target.value)}>
                <option value="">{intl.formatMessage({ id: "transactions.form.chooseAccount", defaultMessage: "Choose an account" })}</option>
                {otherAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.onBudget
                      ? account.name
                      : intl.formatMessage({ id: "transactions.form.offBudgetAccount", defaultMessage: "{name} (off budget)" }, { name: account.name })}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        <div className="field">
          <label htmlFor="tx-payee">{intl.formatMessage({ id: "transactions.form.payee", defaultMessage: "Payee" })}</label>
          <input id="tx-payee" type="text" value={payee} onChange={(event) => setPayee(event.target.value)} maxLength={MAX_FREE_TEXT_LENGTH} />
        </div>

        {(kind === "transfer" ? transferRule !== "none" : !isTransferLeg) && !split && (
          <div className="field">
            <label htmlFor="tx-category">{intl.formatMessage({ id: "transactions.form.category", defaultMessage: "Category" })}</label>
            <select
              id="tx-category"
              value={categoryId}
              {...(kind === "transfer" && hint !== null ? { "aria-describedby": "tx-category-hint" } : {})}
              onChange={(event) => setCategoryId(event.target.value)}>
              {kind === "transfer" && transferRule === "optional" ? (
                <option value="">
                  {budgetMonth
                    ? intl.formatMessage(
                        { id: "transactions.form.unassignedWithAmount", defaultMessage: "Unassigned ({amount})" },
                        { amount: money(budgetMonth.unassigned) },
                      )
                    : intl.formatMessage({ id: "transactions.form.unassigned", defaultMessage: "Unassigned" })}
                </option>
              ) : kind === "in" ? (
                <option value="">{intl.formatMessage({ id: "transactions.form.unassigned", defaultMessage: "Unassigned" })}</option>
              ) : (
                <option value="">{intl.formatMessage({ id: "transactions.form.chooseCategoryOption", defaultMessage: "Choose a category" })}</option>
              )}
              {openCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {kind === "transfer" && hint !== null && (
          <p className="hint" id="tx-category-hint">
            {hint}
          </p>
        )}

        {kind === "out" && !isTransferLeg && (
          <>
            {!split ? (
              <button type="button" className="plain" onClick={() => setSplit(true)}>
                {intl.formatMessage({ id: "transactions.form.split.on", defaultMessage: "Split across categories" })}
              </button>
            ) : (
              <div className="sec">
                <h5>
                  <span>{intl.formatMessage({ id: "transactions.form.split.title", defaultMessage: "Split across categories" })}</span>
                  <button type="button" className="plain" onClick={() => setSplit(false)}>
                    {intl.formatMessage({ id: "transactions.form.split.off", defaultMessage: "Cancel split" })}
                  </button>
                </h5>
                <div className="splits">
                  {lines.map((line, index) => (
                    <div className="sline" key={index}>
                      <label className="sr-only" htmlFor={`sl-cat-${index}`}>
                        {intl.formatMessage({ id: "transactions.form.split.lineCategory", defaultMessage: "Line {n} category" }, { n: index + 1 })}
                      </label>
                      <select id={`sl-cat-${index}`} value={line.categoryId} onChange={(event) => updateLine(index, { categoryId: event.target.value })}>
                        <option value="">{intl.formatMessage({ id: "transactions.form.chooseCategoryOption", defaultMessage: "Choose a category" })}</option>
                        {openCategories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                      <label className="sr-only" htmlFor={`sl-amt-${index}`}>
                        {intl.formatMessage({ id: "transactions.form.split.lineAmount", defaultMessage: "Line {n} amount" }, { n: index + 1 })}
                      </label>
                      <input
                        id={`sl-amt-${index}`}
                        type="text"
                        inputMode="decimal"
                        value={line.amountStr}
                        onChange={(event) => updateLine(index, { amountStr: event.target.value })}
                        placeholder="0.00"
                      />
                      <button
                        type="button"
                        className="rm"
                        aria-label={intl.formatMessage({ id: "transactions.form.split.removeLine", defaultMessage: "Remove line {n}" }, { n: index + 1 })}
                        onClick={() => removeLine(index)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <button type="button" className="plain" onClick={addLine}>
                  {intl.formatMessage({ id: "transactions.form.split.addLine", defaultMessage: "+ Add a line" })}
                </button>
              </div>
            )}
          </>
        )}

        <div className="field">
          <label htmlFor="tx-memo">{intl.formatMessage({ id: "transactions.form.memo", defaultMessage: "Memo" })}</label>
          <input id="tx-memo" type="text" value={memo} onChange={(event) => setMemo(event.target.value)} maxLength={MAX_FREE_TEXT_LENGTH} />
        </div>

        <label className="chk">
          <input type="checkbox" checked={cleared} onChange={(event) => setCleared(event.target.checked)} />
          {intl.formatMessage({ id: "transactions.form.cleared", defaultMessage: "Cleared against the bank" })}
        </label>

        {error && (
          <p className="hint bad" role="alert">
            {error}
          </p>
        )}

        <div className="row-btns">
          <button type="button" className="btn" onClick={onClose}>
            {intl.formatMessage({ id: "common.action.cancel", defaultMessage: "Cancel" })}
          </button>
          <button type="submit" className="btn primary" disabled={submitting}>
            {isEditing
              ? intl.formatMessage({ id: "transactions.form.save", defaultMessage: "Save" })
              : intl.formatMessage({ id: "transactions.form.add", defaultMessage: "Add" })}
          </button>
          {isEditing && (
            <button type="button" className="plain danger" disabled={submitting} onClick={() => void handleDelete()}>
              {intl.formatMessage({ id: "transactions.form.delete", defaultMessage: "Delete" })}
            </button>
          )}
        </div>
      </form>
    </SideSheet>
  );
}
