import { describe, expect, it } from "vitest";

import { negotiateLocale } from "./negotiateLocale.ts";

describe("negotiateLocale (#62)", () => {
  it("picks Italian when it is the browser's own first preference", () => {
    expect(negotiateLocale(["it-IT", "en-US"])).toBe("it");
  });

  it("picks English when it is the browser's own first preference", () => {
    expect(negotiateLocale(["en-US", "it-IT"])).toBe("en");
  });

  it("skips an unsupported language to find a later supported one, in the browser's own order", () => {
    expect(negotiateLocale(["fr-FR", "it-IT"])).toBe("it");
  });

  it("falls back to English when nothing in the list is supported", () => {
    expect(negotiateLocale(["fr-FR", "de-DE"])).toBe("en");
  });

  it("falls back to English for an empty list", () => {
    expect(negotiateLocale([])).toBe("en");
  });

  it("matches the primary subtag only, case-insensitively — 'IT' or 'it-CH' are still Italian", () => {
    expect(negotiateLocale(["IT"])).toBe("it");
    expect(negotiateLocale(["it-CH"])).toBe("it");
  });
});
