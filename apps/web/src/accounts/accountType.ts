import type { TaxRegime } from "@envelope/core";
import { defineMessages } from "react-intl";

import type { AccountType } from "./api.ts";

/** Translated labels for `AccountType`, shared by the account list and the creation form (#51). */
export const ACCOUNT_TYPE_LABELS = defineMessages<AccountType>({
  checking: { id: "accounts.type.checking", defaultMessage: "Checking" },
  savings: { id: "accounts.type.savings", defaultMessage: "Savings" },
  cash: { id: "accounts.type.cash", defaultMessage: "Cash" },
  credit_card: { id: "accounts.type.creditCard", defaultMessage: "Credit card" },
  brokerage: { id: "accounts.type.brokerage", defaultMessage: "Brokerage" },
});

/** Translated labels for a brokerage account's tax regime (#508), in an "IT" workspace. */
export const TAX_REGIME_LABELS = defineMessages<TaxRegime>({
  self_declared: { id: "accounts.taxRegime.selfDeclared", defaultMessage: "Self-declared" },
  administered: { id: "accounts.taxRegime.administered", defaultMessage: "Administered" },
  managed: { id: "accounts.taxRegime.managed", defaultMessage: "Managed" },
});

/** A one-line explanation per tax regime, shown under its own label in the creation form (#508). */
export const TAX_REGIME_HINTS = defineMessages<TaxRegime>({
  self_declared: {
    id: "accounts.taxRegime.selfDeclared.hint",
    defaultMessage: "You report gains and losses in your tax return",
  },
  administered: {
    id: "accounts.taxRegime.administered.hint",
    defaultMessage: "The broker works out and withholds the tax on each gain",
  },
  managed: {
    id: "accounts.taxRegime.managed.hint",
    defaultMessage: "A manager runs the account under a mandate and taxes the result",
  },
});

/** A one-line explanation per `AccountType`, shown under its own label in the creation form (`#402`). */
export const ACCOUNT_TYPE_HINTS = defineMessages<AccountType>({
  checking: { id: "accounts.type.checking.hint", defaultMessage: "Salary, bills, debit card" },
  savings: { id: "accounts.type.savings.hint", defaultMessage: "Money set aside, on or off budget as you choose" },
  cash: { id: "accounts.type.cash.hint", defaultMessage: "Your wallet" },
  credit_card: {
    id: "accounts.type.creditCard.hint",
    defaultMessage: "Debt you pay off, with its own payment category",
  },
  brokerage: { id: "accounts.type.brokerage.hint", defaultMessage: "Investments, always off budget" },
});
