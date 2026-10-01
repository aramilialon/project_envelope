import type { MessageDescriptor } from "react-intl";

import type { AccountType } from "./api.ts";

/** Translated labels for `AccountType`, shared by the account list and the creation form (#51). */
export const ACCOUNT_TYPE_LABELS: Record<AccountType, MessageDescriptor> = {
  checking: { id: "accounts.type.checking", defaultMessage: "Checking" },
  savings: { id: "accounts.type.savings", defaultMessage: "Savings" },
  cash: { id: "accounts.type.cash", defaultMessage: "Cash" },
  credit_card: { id: "accounts.type.creditCard", defaultMessage: "Credit card" },
};
