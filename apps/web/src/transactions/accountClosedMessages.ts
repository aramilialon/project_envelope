import type { IntlShape } from "react-intl";

/**
 * The messages for a write the API refused because an account is closed (#729, #741; 409
 * `account_closed`), shared by every screen that writes a transaction: the transaction form, the
 * register's own one-click actions and the reconciliation. `own` is the account whose register or
 * reconciliation this is; `transfer` is a transfer's other account, closed after the form opened
 * or after the transfer was entered.
 */
export type ClosedAccount = "own" | "transfer";

/**
 * Which account the refusal is about, as far as the screen can tell: a plain transaction has only
 * its own account, and a transfer's is its own when the screen already knows that one is closed
 * (its register reached by its address), else the other one, the account closed meanwhile.
 */
export function closedAccountOf(ownClosed: boolean, isTransfer: boolean): ClosedAccount {
  return ownClosed || !isTransfer ? "own" : "transfer";
}

/** A transaction, or a transfer, that could not be added. */
export function accountClosedAddMessage(intl: IntlShape, closed: ClosedAccount, isTransfer: boolean): string {
  if (closed === "transfer") {
    return intl.formatMessage({
      id: "transactions.form.transferAccountClosedAdd",
      defaultMessage: "This transfer's other account is closed, so the transfer can't be added.",
    });
  }
  return isTransfer
    ? intl.formatMessage({ id: "transactions.form.accountClosedAddTransfer", defaultMessage: "This account is closed, so the transfer can't be added." })
    : intl.formatMessage({ id: "transactions.form.accountClosedAdd", defaultMessage: "This account is closed, so the transaction can't be added." });
}

/** An existing transaction, or transfer, that could not be changed (its status included). */
export function accountClosedChangeMessage(intl: IntlShape, closed: ClosedAccount): string {
  return closed === "own"
    ? intl.formatMessage({ id: "transactions.form.accountClosed", defaultMessage: "This account is closed, so its transactions can't be changed." })
    : intl.formatMessage({
        id: "transactions.form.transferAccountClosed",
        defaultMessage: "This transfer's other account is closed, so this transfer can't be changed.",
      });
}

/** An existing transaction, or transfer, that could not be deleted. */
export function accountClosedDeleteMessage(intl: IntlShape, closed: ClosedAccount): string {
  return closed === "own"
    ? intl.formatMessage({ id: "transactions.form.accountClosedDelete", defaultMessage: "This account is closed, so its transactions can't be deleted." })
    : intl.formatMessage({
        id: "transactions.form.transferAccountClosedDelete",
        defaultMessage: "This transfer's other account is closed, so this transfer can't be deleted.",
      });
}
