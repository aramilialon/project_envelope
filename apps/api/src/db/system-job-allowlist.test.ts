/**
 * `app.is_system_job` (ADR 0010, ADR 0019) lets a connection read every workspace and write
 * shared market data (`prices` with no workspace, `fx_rates`). It must never be set while a
 * request is handled, so only the files below may set it, each for its own narrow purpose. A new
 * file that needs it is added here on purpose, in a reviewed change, never by accident.
 *
 * The list is literal, not read from the code it guards, so a file can neither add itself nor
 * remove another one silently. Every non-test source file in `apps/api/src`, `apps/web/src`,
 * `packages` and `scripts` is searched for the setting's name as a string or after `SET` /
 * `SET LOCAL`, and for a `set_config` whose first argument is anything but one plain literal
 * name (a parameter, a template interpolation, a `||` concatenation), which could set it without
 * naming it. Comment lines are left out of that second search. Migrations only read it
 * (`app_is_system_job()`) and are not searched.
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
  // Lists every workspace and clears the flag, then deletes each one's expired idempotency keys in
  // a transaction of its own (#559).
  "apps/api/src/idempotency/sweep-job.ts",
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

/** The text without its comment lines (`//`, `/*`, ` * `, `--`, `#`), so a docstring quoting `set_config(…)` is not code. */
function withoutCommentLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*|--|#)/.test(line))
    .join("\n");
}

/**
 * A `set_config(` call whose first argument is not one plain literal such as 'app.user_id'
 * followed by a comma: `$1`, `${name}`, `'app.' || $1`, `'app.' + name`, a variable.
 */
const NON_LITERAL_SET_CONFIG = /set_config\((?!\s*'[a-z_]+\.[a-z_]+'\s*,)/i;

async function filesMatching(pattern: RegExp, prepare: (text: string) => string = (text) => text): Promise<string[]> {
  const found: string[] = [];
  for (const directory of SEARCHED) {
    for (const path of await sourceFiles(join(REPOSITORY_ROOT, directory))) {
      if (pattern.test(prepare(await readFile(path, "utf8")))) {
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
    assert.deepEqual(await filesMatching(NON_LITERAL_SET_CONFIG, withoutCommentLines), [...DYNAMIC_SET_CONFIG_ALLOWED].sort());
  });

  it("counts as not literal a name passed as a parameter, interpolated, or concatenated in SQL or in code", () => {
    for (const call of [
      "SELECT set_config($1, 'true', true)",
      "SELECT set_config(${name}, 'true', true)",
      "SELECT set_config('app.' || $1, 'true', true)",
      "SELECT set_config('app.is_' || 'system_job', 'true', true)",
      "SELECT set_config('app.${flag}', 'true', true)",
      "SELECT set_config( 'app.' + name, 'true', true)",
      "SELECT SET_CONFIG(name, 'true', true)",
    ]) {
      assert.ok(NON_LITERAL_SET_CONFIG.test(call), call);
    }
    for (const call of ["SELECT set_config('app.workspace_id', $1, true)", "SELECT set_config( 'app.is_system_job' , 'true', true)"]) {
      assert.ok(!NON_LITERAL_SET_CONFIG.test(call), call);
    }
    assert.equal(withoutCommentLines(" * the flag (`set_config(…, true)`)\n// set_config($1)\nquery()"), "query()");
  });
});
