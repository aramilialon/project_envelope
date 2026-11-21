import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "@formatjs/icu-messageformat-parser";

/**
 * ADR 0004: "A CI check fails if a key is missing in a required language." A required language
 * is every one in `SHIPPED_LOCALES` (`./index.ts`); a catalog file that is not shipped yet is not
 * checked at all, so a translation in progress can land incomplete.
 *
 * For each shipped catalog, checks both directions against the English source — a key `en.json`
 * has but the target does not (needs translating) and a key the target has but `en.json` no
 * longer does (stale, left behind by a renamed or removed message) — and that every ICU variable
 * a message uses (`{name}`, a plural's own `{count}`, a select's own argument…) is the same set in
 * both languages: a translation that drops or renames one silently breaks at render time, the one
 * thing a plain "same keys" check would still miss. In every catalog, the source included, every
 * plural and select must have an `other` branch: it is the one branch ICU falls back to for a
 * value no other branch names, and each language has its own plural categories, so a branch list
 * that is complete in English can miss a category another language needs.
 */
export interface CatalogProblem {
  readonly key: string;
  readonly kind: "missingInTarget" | "staleInTarget" | "argumentMismatch" | "missingOtherBranch" | "invalidMessage";
  readonly detail?: string;
}

/** The parser's node types this check looks at (`@formatjs/icu-messageformat-parser`'s own `TYPE`). */
const LITERAL = 0;
const SELECT = 5;
const PLURAL = 6;
const POUND = 7;

interface MessageNode {
  readonly type: number;
  readonly value?: unknown;
  readonly options?: Record<string, { value: unknown[] }>;
  readonly children?: unknown[];
}

function parseMessage(message: string): readonly unknown[] {
  // `requiresOtherClause: false`: a missing `other` branch is reported as a problem of its own
  // (`missingOtherBranch`) rather than thrown as a parse error.
  return parse(message, { requiresOtherClause: false });
}

function walk(nodes: readonly unknown[], visit: (node: MessageNode) => void): void {
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) {
      continue;
    }
    const n = node as MessageNode;
    visit(n);
    if (n.options) {
      for (const option of Object.values(n.options)) {
        walk(option.value, visit);
      }
    }
    if (n.children) {
      walk(n.children, visit);
    }
  }
}

/** Every ICU argument name a parsed message references, however deep inside a plural/select/tag it sits. */
function argumentNames(nodes: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  walk(nodes, (n) => {
    if (n.type !== LITERAL && n.type !== POUND && typeof n.value === "string") {
      names.add(n.value);
    }
  });
  return names;
}

/** The arguments of every plural or select in a parsed message that has no `other` branch. */
function pluralsAndSelectsWithoutOther(nodes: readonly unknown[]): string[] {
  const missing: string[] = [];
  walk(nodes, (n) => {
    if ((n.type === PLURAL || n.type === SELECT) && n.options && !("other" in n.options)) {
      missing.push(String(n.value));
    }
  });
  return missing;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** Messages that do not parse, or have a plural/select without an `other` branch, in one catalog. */
export function checkMessages(catalog: Readonly<Record<string, string>>): CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  for (const [key, message] of Object.entries(catalog)) {
    let nodes: readonly unknown[];
    try {
      nodes = parseMessage(message);
    } catch (error) {
      problems.push({ key, kind: "invalidMessage", detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const argument of pluralsAndSelectsWithoutOther(nodes)) {
      problems.push({ key, kind: "missingOtherBranch", detail: `{${argument}} has no "other" branch` });
    }
  }
  return problems;
}

/** Compares a target catalog with the source one: keys in both directions, then ICU arguments. */
export function checkCatalogs(
  sourceCatalog: Readonly<Record<string, string>>,
  targetCatalog: Readonly<Record<string, string>>,
): CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  const sourceKeys = Object.keys(sourceCatalog);
  const targetKeys = Object.keys(targetCatalog);

  for (const key of sourceKeys) {
    if (!(key in targetCatalog)) {
      problems.push({ key, kind: "missingInTarget" });
    }
  }
  for (const key of targetKeys) {
    if (!(key in sourceCatalog)) {
      problems.push({ key, kind: "staleInTarget" });
    }
  }
  for (const key of sourceKeys) {
    const targetMessage = targetCatalog[key];
    if (targetMessage === undefined) {
      continue;
    }
    let sourceArgs: Set<string>;
    let targetArgs: Set<string>;
    try {
      sourceArgs = argumentNames(parseMessage(sourceCatalog[key]!));
      targetArgs = argumentNames(parseMessage(targetMessage));
    } catch {
      // Reported as `invalidMessage` by `checkMessages`.
      continue;
    }
    if (!sameSet(sourceArgs, targetArgs)) {
      problems.push({
        key,
        kind: "argumentMismatch",
        detail: `source uses {${[...sourceArgs].join(", ")}}, target uses {${[...targetArgs].join(", ")}}`,
      });
    }
  }
  return problems;
}

/** The problems of one catalog file, `locale` naming it (`it` for `locales/it.json`). */
export interface LocaleProblems {
  readonly locale: string;
  readonly problems: readonly CatalogProblem[];
}

function readCatalog(path: string): Record<string, string> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
}

/**
 * Checks every shipped catalog in `localesDir` (`<locale>.json` each) against the source one.
 * Catalog files of languages that are not in `shippedLocales` are ignored. A shipped language
 * without a catalog file is a problem of its own.
 */
export function checkShippedCatalogs(
  localesDir: string,
  shippedLocales: readonly string[],
  sourceLocale: string,
): LocaleProblems[] {
  const source = readCatalog(join(localesDir, `${sourceLocale}.json`));
  const results: LocaleProblems[] = [{ locale: sourceLocale, problems: checkMessages(source) }];
  for (const locale of shippedLocales) {
    if (locale === sourceLocale) {
      continue;
    }
    const path = join(localesDir, `${locale}.json`);
    if (!existsSync(path)) {
      results.push({ locale, problems: [{ key: `${locale}.json`, kind: "invalidMessage", detail: "catalog file not found" }] });
      continue;
    }
    const target = readCatalog(path);
    results.push({ locale, problems: [...checkCatalogs(source, target), ...checkMessages(target)] });
  }
  return results;
}
