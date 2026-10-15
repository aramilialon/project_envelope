import type { MessageDescriptor } from "react-intl";

import type { AccountType } from "./api.ts";

/** Translated labels for `AccountType`, shared by the account list and the creation form (#51). */
export const ACCOUNT_TYPE_LABELS: Record<AccountType, MessageDescriptor> = {
  checking: { id: "accounts.type.checking", defaultMessage: "Checking" },
  savings: { id: "accounts.type.savings", defaultMessage: "Savings" },
  cash: { id: "accounts.type.cash", defaultMessage: "Cash" },
  credit_card: { id: "accounts.type.creditCard", defaultMessage: "Credit card" },
};

/** A one-line explanation per `AccountType`, shown under its own label in the creation form (`#402`). */
export const ACCOUNT_TYPE_HINTS: Record<AccountType, MessageDescriptor> = {
  checking: { id: "accounts.type.checking.hint", defaultMessage: "Salary, bills, debit card" },
  savings: { id: "accounts.type.savings.hint", defaultMessage: "Money set aside, on or off budget as you choose" },
  cash: { id: "accounts.type.cash.hint", defaultMessage: "Your wallet" },
  credit_card: {
    id: "accounts.type.creditCard.hint",
    defaultMessage: "Debt you pay off, with its own payment category",
  },
};
