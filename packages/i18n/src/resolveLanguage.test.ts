import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveLanguage } from "./resolveLanguage.ts";

// An explicit list, never the real `SHIPPED_LOCALES`: these tests must keep passing the day
// another language ships.
const shipped = ["en", "it"];

function languageFor(deviceTags: readonly string[], list: readonly string[] = shipped): string {
  return resolveLanguage({ stored: null, deviceTags, shipped: list }).language;
}

describe("resolveLanguage: the interface language (#62, #620)", () => {
  it("picks the device's first preference when it is shipped", () => {
    assert.equal(languageFor(["it-IT", "en-US"]), "it");
    assert.equal(languageFor(["en-US", "it-IT"]), "en");
  });

  it("skips a language that is not shipped to find a later one, in the device's own order", () => {
    assert.equal(languageFor(["fr-FR", "it-IT"]), "it");
  });

  it("falls back to English for an empty list", () => {
    assert.equal(languageFor([]), "en");
  });

  it("matches the primary subtag only, case-insensitively: 'IT' and 'it-CH' are still Italian", () => {
    assert.equal(languageFor(["IT"]), "it");
    assert.equal(languageFor(["it-CH"]), "it");
  });

  it("ignores a tag that is not a valid language tag", () => {
    assert.equal(languageFor(["not a tag", "it"]), "it");
  });

  it("reads an underscore as a hyphen: 'it_IT' is Italian", () => {
    assert.equal(languageFor(["it_IT"]), "it");
    assert.equal(languageFor(["de_DE", "it_CH"]), "it");
  });

  it("gives English for German and French while they are not shipped", () => {
    assert.equal(languageFor(["de-DE"]), "en");
    assert.equal(languageFor(["fr-FR", "de-DE"]), "en");
  });

  it("gives German and French once they are shipped", () => {
    const later = ["en", "it", "de", "fr"];
    assert.equal(languageFor(["de-DE"], later), "de");
    assert.equal(languageFor(["fr-CA", "de-DE"], later), "fr");
    assert.equal(languageFor(["es-ES", "de-AT"], later), "de");
    assert.equal(languageFor(["es-ES", "pt-BR"], later), "en");
  });

  it("prefers a stored language over the device's, when it is shipped", () => {
    const resolved = resolveLanguage({ stored: { language: "it", formattingLocale: null }, deviceTags: ["en-US"], shipped });
    assert.equal(resolved.language, "it");
  });

  it("ignores a stored language that is not shipped (any more)", () => {
    const resolved = resolveLanguage({ stored: { language: "de", formattingLocale: null }, deviceTags: ["it-IT"], shipped });
    assert.equal(resolved.language, "it");
  });
});

describe("resolveLanguage: the formatting locale (#620)", () => {
  it("is the device's first preference when it carries a region, even when its language is not shipped", () => {
    assert.deepEqual(resolveLanguage({ stored: null, deviceTags: ["de-CH", "en"], shipped }), {
      language: "en",
      formattingLocale: "de-CH",
    });
  });

  it("is canonicalized", () => {
    assert.equal(resolveLanguage({ stored: null, deviceTags: ["IT-ch"], shipped }).formattingLocale, "it-CH");
  });

  it("is the interface language when the device's first preference has no region", () => {
    assert.deepEqual(resolveLanguage({ stored: null, deviceTags: ["it", "en-US"], shipped }), {
      language: "it",
      formattingLocale: "it",
    });
    assert.equal(resolveLanguage({ stored: null, deviceTags: [], shipped }).formattingLocale, "en");
  });

  it("is the stored choice when there is one, whatever the device says", () => {
    const resolved = resolveLanguage({ stored: { language: null, formattingLocale: "fr-CH" }, deviceTags: ["it-IT"], shipped });
    assert.deepEqual(resolved, { language: "it", formattingLocale: "fr-CH" });
  });

  it("reads an underscore as a hyphen: 'it_IT' formats as it-IT", () => {
    assert.deepEqual(resolveLanguage({ stored: null, deviceTags: ["it_IT"], shipped }), {
      language: "it",
      formattingLocale: "it-IT",
    });
  });

  it("is not built from an undetermined language: 'und-CH' falls back to the interface language", () => {
    assert.deepEqual(resolveLanguage({ stored: null, deviceTags: ["und-CH", "it-IT"], shipped }), {
      language: "it",
      formattingLocale: "it",
    });
    assert.equal(resolveLanguage({ stored: null, deviceTags: ["und-CH"], shipped }).formattingLocale, "en");
  });

  it("ignores a stored formatting locale with an undetermined language", () => {
    const resolved = resolveLanguage({ stored: { language: null, formattingLocale: "und-CH" }, deviceTags: ["en-GB"], shipped });
    assert.equal(resolved.formattingLocale, "en-GB");
  });

  it("ignores a stored formatting locale that is not a valid tag", () => {
    const resolved = resolveLanguage({ stored: { language: null, formattingLocale: "??" }, deviceTags: ["en-GB"], shipped });
    assert.equal(resolved.formattingLocale, "en-GB");
  });
});
