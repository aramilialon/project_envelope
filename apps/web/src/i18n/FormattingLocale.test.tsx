import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";

import { FormattingLocaleProvider, useFormattingLocale } from "./FormattingLocale.tsx";

function Probe() {
  return <span data-testid="locale">{useFormattingLocale()}</span>;
}

describe("useFormattingLocale (#620)", () => {
  it("gives the provider's own locale, apart from the interface language", () => {
    render(
      <IntlProvider locale="en" defaultLocale="en" messages={{}}>
        <FormattingLocaleProvider locale="de-CH">
          <Probe />
        </FormattingLocaleProvider>
      </IntlProvider>,
    );
    expect(screen.getByTestId("locale")).toHaveTextContent("de-CH");
  });

  it("falls back to the interface language without a provider", () => {
    render(
      <IntlProvider locale="it" defaultLocale="en" messages={{}}>
        <Probe />
      </IntlProvider>,
    );
    expect(screen.getByTestId("locale")).toHaveTextContent("it");
  });
});
