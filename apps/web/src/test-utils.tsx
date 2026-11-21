import { formatMoney, MAX_AMOUNT_CENTS } from "@envelope/core";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";

/**
 * An amount in minor units as an English-speaking user types it, with grouping and two decimals:
 * the tests of the cap on a single amount (#651) derive their figures from `MAX_AMOUNT_CENTS`
 * with it, so that they follow the cap if it ever changes.
 */
export function typedAmount(minorUnits: number): string {
  return new Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minorUnits / 100);
}

/** `common.error.amountTooLarge` in English, for a workspace in euros. */
export const AMOUNT_TOO_LARGE_EUR = `An amount is too large: a single amount can be up to ${formatMoney(MAX_AMOUNT_CENTS, { locale: "en", currency: "EUR" })}.`;

/** Every component using `react-intl`'s `useIntl`/`FormattedMessage` needs this in tests. */
export function renderWithIntl(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" defaultLocale="en" messages={{}}>
      {ui}
    </IntlProvider>,
  );
}
