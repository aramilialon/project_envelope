import { resolveLanguage, SHIPPED_LOCALES, type ResolvedLanguage } from "@envelope/i18n";

/**
 * The web app's side of locale negotiation (#62, #620): hands the browser's own ordered language
 * preferences to `resolveLanguage` (`@envelope/i18n`), which decides the same way on every
 * platform. There is no stored choice yet — no "your account" settings screen (ADR 0004) — so
 * `stored` is null and the browser decides. `shippedLocales` exists for tests.
 */
export function negotiateLocale(
  browserLanguages: readonly string[],
  shippedLocales: readonly string[] = SHIPPED_LOCALES,
): ResolvedLanguage {
  return resolveLanguage({ stored: null, deviceTags: browserLanguages, shipped: shippedLocales });
}
