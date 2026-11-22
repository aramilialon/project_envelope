/**
 * `app.is_system_job` (ADR 0010, ADR 0019) lets a connection read every workspace and write
 * shared market data (`prices` with no workspace, `fx_rates`). It must never be set while a
 * request is handled, so only the files below may set it, each for its own narrow purpose. A new
 * file that needs it is added here on purpose, in a reviewed change, never by accident.
 *
 * The list is literal, not read from the code it guards, so a file can neither add itself nor
 * remove another one silently. Every non-test source file in `apps/api/src`, `apps/web/src`,
 * `packages` and `scripts` is searched for the setting's name as a string or after `SET` /
 * `SET LOCAL`, and for a `set_config` whose name is not a literal string, which could set it
 * without naming it. Migrations only read it (`app_is_system_job()`) and are not searched.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SEARCHED = ["apps/api/src", "scripts", "apps/web/src", "packages"];

/** The only files allowed to set the flag. */
const ALLOWED = [
  // Lists every workspace, then fires each one's due scheduled transactions (#38).
  "apps/api/src/scheduled-transactions/fire-job.ts",
  // Writes shared exchange rates, for its own statements only, and resets the flag (#85).
  "apps/api/src/market-data/fx-rates-repository.ts",
];

/**
 * Files that call `set_config` with a name that is not a literal string, checked by hand: each
 * takes its names from its own code, never from a request.
 */
const DYNAMIC_SET_CONFIG_ALLOWED = [
  // withUserScopedTransaction: its callers pass app.workspace_id only (grep its extraSessionVars).
  "apps/api/src/db/pool.ts",
];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(ts|tsx|sql|sh|js|mjs)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.includes(`${"/"}node_modules${"/"}`));
}

async function filesMatching(pattern: RegExp): Promise<string[]> {
  const found: string[] = [];
  for (const directory of SEARCHED) {
    for (const path of await sourceFiles(join(REPOSITORY_ROOT, directory))) {
      if (pattern.test(await readFile(path, "utf8"))) {
        found.push(relative(REPOSITORY_ROOT, path));
      }
    }
  }
  return found.sort();
}

describe("app.is_system_job allowlist (ADR 0010, ADR 0019)", () => {
  it("is set only in the listed files", async () => {
    // The name as a string (set_config's argument, a parameter value) or after SET; a mention in
    // a comment, or the read-only app_is_system_job() function, is not a match.
    assert.deepEqual(
      await filesMatching(/['"`]app\.is_system_job['"`]|\bSET\s+(?:LOCAL\s+|SESSION\s+)?"?app\.is_system_job/i),
      [...ALLOWED].sort(),
    );
  });

  it("is not set through a set_config whose name is not a literal string, outside the files checked by hand", async () => {
    assert.deepEqual(await filesMatching(/set_config\(\s*\$/), [...DYNAMIC_SET_CONFIG_ALLOWED].sort());
  });
});
