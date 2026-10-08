import { parse } from "@formatjs/icu-messageformat-parser";

/**
 * ADR 0004: "A CI check fails if a key is missing in a required language." Checks both
 * directions — a key `en.json` has but `it.json` does not (needs translating) and a key
 * `it.json` has but `en.json` no longer does (stale, left behind by a renamed or removed
 * message) — and that every ICU variable a message uses (`{name}`, a plural's own `{count}`,
 * a select's own argument…) is the same set in both languages: a translation that drops or
 * renames one silently breaks at render time, the one thing a plain "same keys" check would
 * still miss.
 */
export interface CatalogProblem {
  readonly key: string;
  readonly kind: "missingInTarget" | "staleInTarget" | "argumentMismatch";
  readonly detail?: string;
}

/** Every ICU argument name a parsed message references, however deep inside a plural/select/tag it sits. */
function argumentNames(message: string): Set<string> {
  const names = new Set<string>();
  function walk(nodes: readonly unknown[]): void {
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) {
        continue;
      }
      const n = node as { type: number; value?: unknown; options?: Record<string, { value: unknown[] }>; children?: unknown[] };
      if (n.type !== 0 && n.type !== 7 && typeof n.value === "string") {
        names.add(n.value);
      }
      if (n.options) {
        for (const option of Object.values(n.options)) {
          walk(option.value);
        }
      }
      if (n.children) {
        walk(n.children);
      }
    }
  }
  walk(parse(message));
  return names;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

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
    const sourceArgs = argumentNames(sourceCatalog[key]!);
    const targetArgs = argumentNames(targetMessage);
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
