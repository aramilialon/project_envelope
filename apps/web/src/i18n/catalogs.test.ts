import { SHIPPED_LOCALES, SOURCE_LOCALE, type Catalog } from "@envelope/i18n";
import en from "@envelope/i18n/locales/en.json";
import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { CATALOG_LOADERS, loadCatalog } from "./catalogs.ts";

type Values = Record<string, unknown>;

/**
 * Sample values for every argument a message uses, then one variant per plural count and per
 * select branch, so every branch of every message is formatted at least once.
 */
function sampleValues(elements: readonly MessageFormatElement[]): Values[] {
  const base: Values = {};
  const variants: Values[] = [];
  function walk(nodes: readonly MessageFormatElement[]): void {
    for (const node of nodes) {
      switch (node.type) {
        case TYPE.argument:
          base[node.value] ??= "Sample";
          break;
        case TYPE.number:
          base[node.value] ??= 1234.5;
          break;
        case TYPE.date:
        case TYPE.time:
          base[node.value] ??= new Date(Date.UTC(2026, 0, 31, 12));
          break;
        case TYPE.plural:
          base[node.value] ??= 1;
          for (const count of [0, 1, 2, 5, 21, 1_000_000]) {
            variants.push({ [node.value]: count });
          }
          for (const option of Object.values(node.options)) walk(option.value);
          break;
        case TYPE.select:
          base[node.value] ??= "other";
          for (const key of Object.keys(node.options)) {
            variants.push({ [node.value]: key });
          }
          for (const option of Object.values(node.options)) walk(option.value);
          break;
        case TYPE.tag:
          base[node.value] ??= (chunks: unknown[]) => chunks.join("");
          walk(node.children);
          break;
        default:
          break;
      }
    }
  }
  walk(elements);
  return [base, ...variants.map((variant) => ({ ...base, ...variant }))];
}

async function catalogFor(language: string): Promise<Catalog> {
  // The source language has no runtime catalog; `en.json` holds its messages all the same.
  return language === SOURCE_LOCALE ? en : loadCatalog(language);
}

describe("the shipped catalogs (#620)", () => {
  it("every shipped language other than English has a catalog loader", () => {
    expect(Object.keys(CATALOG_LOADERS).sort()).toEqual(SHIPPED_LOCALES.filter((l) => l !== SOURCE_LOCALE).sort());
  });

  it("English has no runtime catalog: the components' own defaultMessages are the text", async () => {
    expect(await loadCatalog(SOURCE_LOCALE)).toEqual({});
  });

  it("refuses a language that is not shipped", async () => {
    await expect(loadCatalog("xx")).rejects.toThrow(/no catalog loader/);
  });

  it.each(SHIPPED_LOCALES)("formats every message of %s with sample arguments without an error", async (language) => {
    const messages = await catalogFor(language);
    const errors: string[] = [];
    const intl = createIntl({
      locale: language,
      defaultLocale: SOURCE_LOCALE,
      messages,
      onError: (error) => errors.push(`${error.code}: ${error.message}`),
    });
    const keys = Object.keys(en);
    expect(keys.length).toBeGreaterThan(0);
    for (const id of keys) {
      const message = messages[id];
      expect(message, `${language}: ${id} is missing`).toBeDefined();
      for (const values of sampleValues(parse(message!))) {
        const formatted = intl.formatMessage({ id }, values as Record<string, string>);
        expect(typeof formatted === "string" || Array.isArray(formatted), `${language}: ${id}`).toBe(true);
      }
    }
    expect(errors).toEqual([]);
  });
});
