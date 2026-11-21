import { SHIPPED_LOCALES, SOURCE_LOCALE, type Catalog } from "@envelope/i18n";
import en from "@envelope/i18n/locales/en.json";
import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";

import { CATALOG_LOADERS, loadCatalog } from "./catalogs.ts";

type Values = Record<string, unknown>;

/** Plural counts tried in every plural: enough to reach every category of every shipped language. */
const PLURAL_COUNTS = [0, 1, 2, 5, 21, 1_000_000];

/**
 * A sample value for every argument the *English* message uses. Built from the source message,
 * never the translation: a translation that invents an argument of its own is then formatted
 * without a value for it, and fails.
 */
function argumentValues(elements: readonly MessageFormatElement[], values: Values = {}): Values {
  for (const node of elements) {
    switch (node.type) {
      case TYPE.argument:
        values[node.value] ??= "Sample";
        break;
      case TYPE.number:
        values[node.value] ??= 1234.5;
        break;
      case TYPE.date:
      case TYPE.time:
        values[node.value] ??= new Date(Date.UTC(2026, 0, 31, 12));
        break;
      case TYPE.plural:
        values[node.value] ??= 1;
        for (const option of Object.values(node.options)) argumentValues(option.value, values);
        break;
      case TYPE.select:
        values[node.value] ??= "other";
        for (const option of Object.values(node.options)) argumentValues(option.value, values);
        break;
      case TYPE.tag:
        values[node.value] ??= (chunks: unknown[]) => chunks.join("");
        argumentValues(node.children, values);
        break;
      default:
        break;
    }
  }
  return values;
}

/**
 * The values that reach every branch of the *translated* message: each plural's sample counts
 * plus every `=N` it names, and each select's keys, however deeply nested.
 */
function branchValues(elements: readonly MessageFormatElement[], branches = new Map<string, Set<unknown>>()): Map<string, Set<unknown>> {
  const add = (name: string, value: unknown): void => {
    const set = branches.get(name) ?? new Set<unknown>();
    set.add(value);
    branches.set(name, set);
  };
  for (const node of elements) {
    switch (node.type) {
      case TYPE.plural:
        for (const count of PLURAL_COUNTS) add(node.value, count);
        for (const [key, option] of Object.entries(node.options)) {
          const exact = /^=(\d+(?:\.\d+)?)$/.exec(key);
          if (exact !== null) add(node.value, Number(exact[1]));
          branchValues(option.value, branches);
        }
        break;
      case TYPE.select:
        for (const [key, option] of Object.entries(node.options)) {
          add(node.value, key);
          branchValues(option.value, branches);
        }
        break;
      case TYPE.tag:
        branchValues(node.children, branches);
        break;
      default:
        break;
    }
  }
  return branches;
}

/**
 * The argument sets to format a message with: the English message's arguments, crossed with
 * every combination of the translation's plural and select branches, so a branch nested inside
 * another one is reached too. Only arguments the English message has are varied: a plural or
 * select the translation invents gets no value, and fails.
 */
function sampleValues(source: readonly MessageFormatElement[], target: readonly MessageFormatElement[]): Values[] {
  const base = argumentValues(source);
  let combinations: Values[] = [base];
  for (const [name, values] of branchValues(target)) {
    if (!(name in base)) continue;
    combinations = combinations.flatMap((combination) => [...values].map((value) => ({ ...combination, [name]: value })));
  }
  return combinations;
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
      for (const values of sampleValues(parse((en as Catalog)[id]!), parse(message!))) {
        const formatted = intl.formatMessage({ id }, values as Record<string, string>);
        expect(typeof formatted === "string" || Array.isArray(formatted), `${language}: ${id}`).toBe(true);
      }
    }
    expect(errors).toEqual([]);
  });
});
