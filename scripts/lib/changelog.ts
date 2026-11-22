/**
 * Changelog fragments (#738): each branch adds `changes/unreleased/<issue>-<slug>.md` instead of
 * editing `CHANGELOG.md`, so pull requests that land together no longer conflict there. At release
 * time `changelog-release.ts` compiles them into a new version section. This module is pure (no
 * file system), so every rule is tested in `changelog.test.ts`.
 *
 * A fragment is:
 *
 *     Fixed
 *
 *     - `apps/web`: what changed, for whom (`#123`).
 *
 * Its first line is exactly one of the sections below, then a blank line, then one or more
 * Markdown list items (continuation lines indented), copied into the changelog as they are.
 */

export const SECTIONS = ["Added", "Changed", "Fixed", "Removed"] as const;
export type Section = (typeof SECTIONS)[number];

export const FRAGMENT_NAME = /^(\d+)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNRELEASED_HEADING = "## [Unreleased]";

export interface Fragment {
  readonly name: string;
  readonly issue: number;
  readonly section: Section;
  /** The list items, without a trailing newline. */
  readonly body: string;
}

function isCalendarDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function isSection(value: string): value is Section {
  return (SECTIONS as readonly string[]).includes(value);
}

/** Parses one fragment file; throws an error naming the file and what is wrong. */
export function parseFragment(name: string, text: string): Fragment {
  const match = FRAGMENT_NAME.exec(name);
  if (!match) {
    throw new Error(`${name}: the file name must be <issue>-<slug>.md, lower case, for example 738-changelog-fragments.md`);
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const section = (lines[0] ?? "").trim();
  if (!isSection(section)) {
    throw new Error(`${name}: the first line must be one of ${SECTIONS.join(", ")}, found "${lines[0] ?? ""}"`);
  }
  if ((lines[1] ?? "").trim() !== "") {
    throw new Error(`${name}: the second line must be blank`);
  }
  const body = lines.slice(2).join("\n").trim();
  if (body === "") {
    throw new Error(`${name}: the entry is empty`);
  }
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    if (!line.startsWith("- ") && !line.startsWith(" ")) {
      throw new Error(`${name}: every entry must be a list item ("- ..."), with continuation lines indented; found "${line}"`);
    }
  }
  return { name, issue: Number(match[1]), section, body };
}

/** Fragments in release order: by issue number, then by file name. */
export function sortFragments(fragments: readonly Fragment[]): Fragment[] {
  return [...fragments].sort((a, b) => a.issue - b.issue || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

interface UnreleasedSplit {
  readonly before: string[];
  /** Entries written directly under "Unreleased" (a branch started before #738), by section. */
  readonly legacy: Map<Section, string[]>;
  readonly after: string[];
}

function splitAtUnreleased(changelog: string): UnreleasedSplit {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf(UNRELEASED_HEADING);
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" heading`);
  }
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end === -1) end = lines.length;

  const legacy = new Map<Section, string[]>();
  let current: Section | undefined;
  for (const line of lines.slice(start + 1, end)) {
    if (line.startsWith("### ")) {
      const heading = line.slice(4).trim();
      if (!isSection(heading)) {
        throw new Error(`CHANGELOG.md: unknown section "${heading}" under Unreleased; use one of ${SECTIONS.join(", ")}`);
      }
      current = heading;
      continue;
    }
    if (line.trim() === "") continue;
    if (current === undefined) {
      throw new Error(`CHANGELOG.md: text under Unreleased before any section heading: "${line}"`);
    }
    const entries = legacy.get(current) ?? [];
    entries.push(line);
    legacy.set(current, entries);
  }
  return { before: lines.slice(0, start + 1), legacy, after: lines.slice(end) };
}

export interface ReleaseInput {
  readonly changelog: string;
  readonly fragments: readonly Fragment[];
  readonly version: string;
  /** YYYY-MM-DD. */
  readonly date: string;
}

/**
 * Returns the new `CHANGELOG.md`: an empty "Unreleased" heading, then `## [version] - date` with
 * the entries still written under "Unreleased" followed by the fragments, grouped by section in
 * the order of `SECTIONS`.
 */
export function compileRelease({ changelog, fragments, version, date }: ReleaseInput): string {
  if (!VERSION.test(version)) {
    throw new Error(`"${version}" is not a version (X.Y.Z)`);
  }
  if (!DATE.test(date) || !isCalendarDate(date)) {
    throw new Error(`"${date}" is not a date (YYYY-MM-DD)`);
  }
  if (changelog.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  const { before, legacy, after } = splitAtUnreleased(changelog);
  const sorted = sortFragments(fragments);

  const release: string[] = [`## [${version}] - ${date}`];
  for (const section of SECTIONS) {
    const entries = [...(legacy.get(section) ?? []), ...sorted.filter((f) => f.section === section).map((f) => f.body)];
    if (entries.length === 0) continue;
    release.push("", `### ${section}`, "", ...entries);
  }
  if (release.length === 1) {
    throw new Error("nothing to release: no fragments in changes/unreleased/ and no entries under Unreleased");
  }
  return [...before, "", ...release, "", ...after].join("\n");
}
