/**
 * Compiles the changelog fragments in `changes/unreleased/` into `CHANGELOG.md` under a new release
 * heading, then deletes them (#738; release step 4 of docs/how-to/work-with-issues-and-pull-requests.md).
 *
 *     pnpm --filter @envelope/scripts changelog:release 0.2.1 [--date YYYY-MM-DD]
 *     pnpm --filter @envelope/scripts changelog:check
 *
 * `--date` defaults to today in UTC. `--check` only validates the fragments and changes nothing.
 * The rules live in `lib/changelog.ts`; both are tested in `lib/changelog.test.ts`.
 */

import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { compileRelease, parseFragment, type Fragment } from "./lib/changelog.ts";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");

export function fragmentsDir(root: string): string {
  return join(root, "changes", "unreleased");
}

/** Every fragment in `<root>/changes/unreleased/`, parsed; the README and dot files are skipped. */
export function readFragments(root: string): Fragment[] {
  const dir = fragmentsDir(root);
  return readdirSync(dir)
    .filter((name) => name !== "README.md" && !name.startsWith("."))
    .map((name) => parseFragment(name, readFileSync(join(dir, name), "utf8")));
}

/** Writes the release into `<root>/CHANGELOG.md` and deletes the fragments it compiled. */
export function release(root: string, version: string, date: string): number {
  const fragments = readFragments(root);
  const path = join(root, "CHANGELOG.md");
  writeFileSync(path, compileRelease({ changelog: readFileSync(path, "utf8"), fragments, version, date }));
  for (const fragment of fragments) {
    unlinkSync(join(fragmentsDir(root), fragment.name));
  }
  return fragments.length;
}

function main(args: string[]): void {
  if (args.length === 1 && args[0] === "--check") {
    console.log(`${readFragments(REPOSITORY_ROOT).length} changelog fragment(s) valid`);
    return;
  }
  const [version, flag, value] = args;
  if (version === undefined || version.startsWith("-") || args.length === 2 || args.length > 3 || (flag !== undefined && flag !== "--date")) {
    console.error("usage: changelog-release.ts <X.Y.Z> [--date YYYY-MM-DD] | --check");
    process.exit(2);
  }
  const date = value ?? new Date().toISOString().slice(0, 10);
  const count = release(REPOSITORY_ROOT, version, date);
  console.log(`CHANGELOG.md: [${version}] - ${date}, ${count} fragment(s) compiled and deleted`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
