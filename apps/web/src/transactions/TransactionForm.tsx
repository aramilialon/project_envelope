import { formatMoney, parseAmount } from "@envelope/core";
import { useState, type FormEvent } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import type { Account } from "../accounts/api.ts";
import type { Category } from "../categories/api.ts";
import { createTransaction, createTransfer, updateTransaction, type SplitInput, type Transaction } from "./api.ts";
import { totalOf } from "./transactionAmount.ts";
import "./TransactionForm.css";

type Kind = "out" | "in" | "transfer";

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
  /** Absent creates a new transaction; given, edits that one. */
  readonly transaction?: Transaction;
  onClose(): void;
  onSaved(): void;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function kindOf(transaction: Transaction | undefined): Kind {
  if (!transaction) return "out";
  if (transaction.transferId !== null) return "transfer";
  return totalOf(transaction) < 0 ? "out" : "in";
}

function centsToInput(cents: number, locale: string): string {
  return (cents / 100).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The register's "+ New transaction" / "edit a row" side panel (#54): outflow, inflow or
 * transfer, splitting an outflow across categories. `apps/api`'s `updateTransaction` has no
 * `occurredAt` field, so an existing transaction's date cannot be changed here, only at
 * creation; a transfer's amount and destination account are the same way (`createTransfer` is
 * the only atomic, two-legs-at-once write) — editing an existing transfer is limited to its
 * payee, memo and cleared status. Deleting a transaction has no endpoint yet, so there is no
 * "Delete" button, unlike the mockup. A reconciled transaction is never handed to this form —
 * `AccountRegisterScreen` shows it read-only instead, since unlocking one has no endpoint yet.
 */
export default function TransactionForm({ workspaceId, accountId, accounts, categories, currency, transaction, onClose, onSaved }: Props) {
  const intl = useIntl();
  const auth = useAuth();
  const isEditing = transaction !== undefined;
  const isTransferLeg = transaction !== undefined && transaction.transferId !== null;

  const [kind, setKind] = useState<Kind>(kindOf(transaction));
  const [date] = useState(transaction?.budgetDate ?? today());
  const [amountStr, setAmountStr] = useState(transaction ? centsToInput(Math.abs(totalOf(transaction)), intl.locale) : "");
  const [payee, setPayee] = useState(transaction?.payee ?? "");
  const [memo, setMemo] = useState(transaction?.memo ?? "");
  const [cleared, setCleared] = useState(transaction ? transaction.status !== "pending" : false);
  const [categoryId, setCategoryId] = useState(
    !isTransferLeg && transaction?.splits.length === 1 ? (transaction.splits[0]!.categoryId ?? "") : "",
  );
  const [split, setSplit] = useState(!isTransferLeg && (transaction?.splits.length ?? 0) > 1);
  const [lines, setLines] = useState<SplitLine[]>(
    !isTransferLeg && (transaction?.splits.length ?? 0) > 1
      ? transaction!.splits.map((s) => ({ categoryId: s.categoryId ?? "", amountStr: centsToInput(Math.abs(s.amountCents), intl.locale) }))
      : [{ categoryId: "", amountStr: "" }, { categoryId: "", amountStr: "" }],
  );
  const [destinationAccountId, setDestinationAccountId] = useState(
    isTransferLeg ? (accounts.find((a) => a.id !== accountId && a.id !== transaction?.accountId)?.id ?? "") : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const otherAccounts = accounts.filter((a) => a.id !== accountId);
  const openCategories = categories.filter((c) => !c.archived);

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
    } catch {
      setError(intl.formatMessage({ id: "transactions.form.invalidAmount", defaultMessage: "Enter an amount greater than zero." }));
      return;
    }

    setSubmitting(true);
    try {
      if (kind === "transfer") {
        if (isEditing) {
          await updateTransaction(accessToken, workspaceId, accountId, transaction.id, {
            ...(payee ? { payee } : {}),
            ...(memo ? { memo } : {}),
            status: cleared ? "cleared" : "pending",
          });
        } else {
          if (!destinationAccountId) {
            setError(intl.formatMessage({ id: "transactions.form.chooseDestination", defaultMessage: "Choose a destination account." }));
            setSubmitting(false);
            return;
          }
          await createTransfer(accessToken, workspaceId, {
            sourceAccountId: accountId,
            destinationAccountId,
            occurredAt: date,
            amountCents: amount,
            ...(payee ? { payee } : {}),
            ...(memo ? { memo } : {}),
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
          await updateTransaction(accessToken, workspaceId, accountId, transaction.id, {
            ...(payee ? { payee } : {}),
            ...(memo ? { memo } : {}),
            status: cleared ? "cleared" : "pending",
            splits,
            amountCents,
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
    } catch {
      setError(intl.formatMessage({ id: "transactions.form.error", defaultMessage: "We could not save this transaction." }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="side-sheet transaction-form"
      role="dialog"
      aria-modal="true"
      aria-label={intl.formatMessage(
        isEditing
          ? { id: "transactions.form.editTitle", defaultMessage: "Edit transaction" }
          : { id: "transactions.form.newTitle", defaultMessage: "New transaction" },
      )}
    >
      <div className="panel-head">
        <h2>
          {intl.formatMessage(
            isEditing
              ? { id: "transactions.form.editTitle", defaultMessage: "Edit transaction" }
              : { id: "transactions.form.newTitle", defaultMessage: "New transaction" },
          )}
        </h2>
        <button type="button" className="plain" onClick={onClose}>
          {intl.formatMessage({ id: "common.action.close", defaultMessage: "× Close" })}
        </button>
      </div>

      <form onSubmit={(event) => void handleSubmit(event)}>
        <fieldset className="segs" disabled={isEditing}>
          <legend className="sr-only">{intl.formatMessage({ id: "transactions.form.kind", defaultMessage: "Kind" })}</legend>
          <label>
            <input type="radio" name="kind" checked={kind === "out"} onChange={() => setKind("out")} />
            <span>{intl.formatMessage({ id: "transactions.form.kind.out", defaultMessage: "Outflow" })}</span>
          </label>
          <label>
            <input type="radio" name="kind" checked={kind === "in"} onChange={() => setKind("in")} />
            <span>{intl.formatMessage({ id: "transactions.form.kind.in", defaultMessage: "Inflow" })}</span>
          </label>
          <label>
            <input type="radio" name="kind" checked={kind === "transfer"} onChange={() => setKind("transfer")} />
            <span>{intl.formatMessage({ id: "transactions.form.kind.transfer", defaultMessage: "Transfer" })}</span>
          </label>
        </fieldset>

        <div className="two">
          <div className="field">
            <label htmlFor="tx-date">{intl.formatMessage({ id: "transactions.form.date", defaultMessage: "Date" })}</label>
            <input id="tx-date" type="date" value={date} disabled readOnly />
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
          <div className="field">
            <label htmlFor="tx-destination">{intl.formatMessage({ id: "transactions.form.destination", defaultMessage: "To account" })}</label>
            <select
              id="tx-destination"
              value={destinationAccountId}
              disabled={isEditing}
              onChange={(event) => setDestinationAccountId(event.target.value)}
            >
              <option value="">{intl.formatMessage({ id: "transactions.form.chooseAccount", defaultMessage: "Choose an account" })}</option>
              {otherAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <label htmlFor="tx-payee">{intl.formatMessage({ id: "transactions.form.payee", defaultMessage: "Payee" })}</label>
          <input id="tx-payee" type="text" value={payee} onChange={(event) => setPayee(event.target.value)} />
        </div>

        {kind !== "transfer" && !split && (
          <div className="field">
            <label htmlFor="tx-category">{intl.formatMessage({ id: "transactions.form.category", defaultMessage: "Category" })}</label>
            <select id="tx-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              {kind === "in" ? (
                <option value="">{intl.formatMessage({ id: "transactions.form.unassigned", defaultMessage: "Ready to assign" })}</option>
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
          <input id="tx-memo" type="text" value={memo} onChange={(event) => setMemo(event.target.value)} />
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
            {intl.formatMessage(
              isEditing
                ? { id: "transactions.form.save", defaultMessage: "Save" }
                : { id: "transactions.form.add", defaultMessage: "Add" },
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
