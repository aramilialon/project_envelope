export type SupportedLocale = "en" | "it";

/**
 * Picks the interface language from the browser's own ordered language preferences (ADR 0004:
 * "language" is a real user setting eventually — a "your account" screen with no issue yet — this
 * is the reasonable default until one exists). The first preference that is English or Italian
 * wins, in the browser's own order, so a preference list like `["fr", "it", "en"]` still picks
 * Italian rather than falling straight through to the English default; anything else (`#62` adds
 * only these two) falls back to English, the source language.
 */
export function negotiateLocale(browserLanguages: readonly string[]): SupportedLocale {
  for (const language of browserLanguages) {
    const primary = language.toLowerCase().split("-")[0];
    if (primary === "it") {
      return "it";
    }
    if (primary === "en") {
      return "en";
    }
  }
  return "en";
}
