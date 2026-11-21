import { describe, expect, it } from "vitest";

import { negotiateLocale } from "./negotiateLocale.ts";

// The rules themselves are tested in `packages/i18n` (`resolveLanguage.test.ts`); this checks
// the web app hands them the shipped list and the browser's preferences.
describe("negotiateLocale (#62, #620)", () => {
  it("picks Italian when it is the browser's own first preference", () => {
    expect(negotiateLocale(["it-IT", "en-US"])).toEqual({ language: "it", formattingLocale: "it-IT" });
  });

  it("gives English while German is not shipped, and German once it is", () => {
    expect(negotiateLocale(["de-DE"]).language).toBe("en");
    expect(negotiateLocale(["de-DE"], ["en", "it", "de"]).language).toBe("de");
  });

  it("gives English, formatted the browser's way, for a language that is not shipped", () => {
    expect(negotiateLocale(["fr-FR"])).toEqual({ language: "en", formattingLocale: "fr-FR" });
  });
});
