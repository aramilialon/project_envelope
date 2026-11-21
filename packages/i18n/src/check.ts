/**
 * `pnpm --filter @envelope/i18n check`: the catalog completeness check (ADR 0004), a required
 * CI step of its own rather than part of `pnpm test`, so a translation in progress never turns
 * the test suite red. Checks every catalog in `SHIPPED_LOCALES` against `en.json`; exits with a
 * non-zero status and lists every problem if any is found.
 */
import { fileURLToPath } from "node:url";

import { checkShippedCatalogs } from "./checkComplete.ts";
import { SHIPPED_LOCALES, SOURCE_LOCALE } from "./index.ts";

const localesDir = fileURLToPath(new URL("../locales/", import.meta.url));
const results = checkShippedCatalogs(localesDir, SHIPPED_LOCALES, SOURCE_LOCALE);

let total = 0;
for (const { locale, problems } of results) {
  if (problems.length === 0) {
    console.log(`${locale}.json: complete`);
    continue;
  }
  total += problems.length;
  console.error(`${locale}.json: ${problems.length} problem(s)`);
  for (const problem of problems) {
    console.error(`  ${problem.kind} — ${problem.key}${problem.detail ? ` (${problem.detail})` : ""}`);
  }
}

if (total > 0) {
  console.error(`\n${total} problem(s) in the shipped catalogs (${SHIPPED_LOCALES.join(", ")}).`);
  process.exitCode = 1;
}
