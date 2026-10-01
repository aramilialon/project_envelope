import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";

/** Every component using `react-intl`'s `useIntl`/`FormattedMessage` needs this in tests. */
export function renderWithIntl(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" defaultLocale="en" messages={{}}>
      {ui}
    </IntlProvider>,
  );
}
