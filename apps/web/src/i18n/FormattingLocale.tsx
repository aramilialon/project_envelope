import { createContext, useContext, type ReactNode } from "react";
import { useIntl } from "react-intl";

/**
 * The locale amounts, numbers and dates are formatted and parsed in (#620), kept apart from the
 * interface language `IntlProvider` carries: someone whose browser says `de-CH` reads the
 * interface in English while German is not shipped, but should still type and read amounts the
 * Swiss way. Plural rules and every translated message keep following the interface language.
 *
 * `main.tsx` provides it; for now it gives the interface language itself, so nothing changes yet.
 * Moving the existing `formatMoney`/`parseAmount`/date calls from `intl.locale` to
 * `useFormattingLocale()` is a follow-up.
 */
const FormattingLocaleContext = createContext<string | null>(null);

export function FormattingLocaleProvider({ locale, children }: { locale: string; children: ReactNode }) {
  return <FormattingLocaleContext.Provider value={locale}>{children}</FormattingLocaleContext.Provider>;
}

/** The formatting locale; the interface language when no provider is above (component tests). */
export function useFormattingLocale(): string {
  const intl = useIntl();
  return useContext(FormattingLocaleContext) ?? intl.locale;
}
