import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { fragmentsDir, readFragments, release, REPOSITORY_ROOT } from "../changelog-release.ts";
import { compileRelease, parseFragment, sortFragments } from "./changelog.ts";

const HEAD = "# Changelog\n\nIntro.\n\n## [Unreleased]\n";
const PREVIOUS = "## [0.2.0] - 2026-11-21\n\n### Added\n\n- Old entry.\n";

describe("parseFragment", () => {
  it("reads the section and keeps the list items as they are", () => {
    const fragment = parseFragment("738-changelog-fragments.md", "Changed\n\n- One.\n  Continued.\n- Two.\n");
    assert.deepEqual(fragment, {
      name: "738-changelog-fragments.md",
      issue: 738,
      section: "Changed",
      body: "- One.\n  Continued.\n- Two.",
    });
  });

  it("accepts Windows line endings", () => {
    assert.equal(parseFragment("1-a.md", "Fixed\r\n\r\n- One.\r\n").body, "- One.");
  });

  it("refuses a file name without an issue number or with upper case", () => {
    assert.throws(() => parseFragment("changelog.md", "Added\n\n- One.\n"), /file name/);
    assert.throws(() => parseFragment("738-Fragments.md", "Added\n\n- One.\n"), /file name/);
    assert.throws(() => parseFragment("738-.md", "Added\n\n- One.\n"), /file name/);
    assert.throws(() => parseFragment("738-a.txt", "Added\n\n- One.\n"), /file name/);
  });

  it("refuses an unknown section, a heading as the first line, or a lower-case section", () => {
    assert.throws(() => parseFragment("1-a.md", "Security\n\n- One.\n"), /first line/);
    assert.throws(() => parseFragment("1-a.md", "### Added\n\n- One.\n"), /first line/);
    assert.throws(() => parseFragment("1-a.md", "added\n\n- One.\n"), /first line/);
  });

  it("refuses a missing blank line, an empty entry, prose, or a heading in the body", () => {
    assert.throws(() => parseFragment("1-a.md", "Added\n- One.\n"), /second line/);
    assert.throws(() => parseFragment("1-a.md", "Added\n\n\n"), /empty/);
    assert.throws(() => parseFragment("1-a.md", "Added"), /empty/);
    assert.throws(() => parseFragment("1-a.md", "Added\n\nNot a list item.\n"), /list item/);
    assert.throws(() => parseFragment("1-a.md", "Added\n\n- One.\n### Fixed\n- Two.\n"), /list item/);
  });
});

describe("sortFragments", () => {
  it("orders by issue number numerically, then by file name", () => {
    const names = sortFragments([
      parseFragment("100-b.md", "Added\n\n- B.\n"),
      parseFragment("99-z.md", "Added\n\n- Z.\n"),
      parseFragment("100-a.md", "Added\n\n- A.\n"),
    ]).map((f) => f.name);
    assert.deepEqual(names, ["99-z.md", "100-a.md", "100-b.md"]);
  });
});

describe("compileRelease", () => {
  const fragments = [
    parseFragment("745-web-refusal.md", "Fixed\n\n- Fix two.\n"),
    parseFragment("74-brokerage.md", "Added\n\n- Add one.\n"),
    parseFragment("700-fix.md", "Fixed\n\n- Fix one.\n"),
    parseFragment("701-drop.md", "Removed\n\n- Gone.\n"),
  ];

  it("writes a release section under an empty Unreleased heading, sections in order, issues ascending", () => {
    const result = compileRelease({ changelog: `${HEAD}\n${PREVIOUS}`, fragments, version: "0.2.1", date: "2026-11-30" });
    assert.equal(
      result,
      `${HEAD}\n## [0.2.1] - 2026-11-30\n\n### Added\n\n- Add one.\n\n### Fixed\n\n- Fix one.\n- Fix two.\n\n### Removed\n\n- Gone.\n\n${PREVIOUS}`,
    );
  });

  it("keeps entries still written under Unreleased, before the fragments of their section", () => {
    const changelog = `${HEAD}\n### Fixed\n\n- Legacy fix.\n  Continued.\n\n### Changed\n\n- Legacy change.\n\n${PREVIOUS}`;
    const result = compileRelease({ changelog, fragments: [fragments[2]!], version: "0.2.1", date: "2026-11-30" });
    assert.equal(
      result,
      `${HEAD}\n## [0.2.1] - 2026-11-30\n\n### Changed\n\n- Legacy change.\n\n### Fixed\n\n- Legacy fix.\n  Continued.\n- Fix one.\n\n${PREVIOUS}`,
    );
  });

  it("works on a changelog with no earlier release", () => {
    const result = compileRelease({ changelog: HEAD, fragments: [fragments[1]!], version: "0.1.0", date: "2026-01-01" });
    assert.equal(result, `${HEAD}\n## [0.1.0] - 2026-01-01\n\n### Added\n\n- Add one.\n`);
  });

  it("refuses a bad version or date, an existing version, or nothing to release", () => {
    const changelog = `${HEAD}\n${PREVIOUS}`;
    assert.throws(() => compileRelease({ changelog, fragments, version: "v0.2.1", date: "2026-11-30" }), /not a version/);
    assert.throws(() => compileRelease({ changelog, fragments, version: "0.2.1", date: "30/11/2026" }), /not a date/);
    assert.throws(() => compileRelease({ changelog, fragments, version: "0.2.1", date: "2026-13-01" }), /not a date/);
    assert.throws(() => compileRelease({ changelog, fragments, version: "0.2.1", date: "2026-02-30" }), /not a date/);
    assert.throws(() => compileRelease({ changelog, fragments, version: "0.2.0", date: "2026-11-30" }), /already has/);
    assert.throws(() => compileRelease({ changelog, fragments: [], version: "0.2.1", date: "2026-11-30" }), /nothing to release/);
  });

  it("refuses a changelog without Unreleased, or with text it cannot place", () => {
    assert.throws(() => compileRelease({ changelog: "# Changelog\n", fragments, version: "0.2.1", date: "2026-11-30" }), /no "## \[Unreleased\]"/);
    assert.throws(
      () => compileRelease({ changelog: `${HEAD}\n- Orphan.\n`, fragments, version: "0.2.1", date: "2026-11-30" }),
      /before any section heading/,
    );
    assert.throws(
      () => compileRelease({ changelog: `${HEAD}\n### Security\n\n- X.\n`, fragments, version: "0.2.1", date: "2026-11-30" }),
      /unknown section/,
    );
  });
});

describe("release", () => {
  it("writes CHANGELOG.md and deletes the fragments, keeping the README", () => {
    const root = mkdtempSync(join(tmpdir(), "envelope-changelog-"));
    try {
      mkdirSync(fragmentsDir(root), { recursive: true });
      writeFileSync(join(root, "CHANGELOG.md"), `${HEAD}\n${PREVIOUS}`);
      writeFileSync(join(fragmentsDir(root), "README.md"), "# Format\n");
      writeFileSync(join(fragmentsDir(root), "738-fragments.md"), "Changed\n\n- New flow.\n");

      assert.equal(release(root, "0.2.1", "2026-11-30"), 1);
      assert.match(readFileSync(join(root, "CHANGELOG.md"), "utf8"), /## \[0\.2\.1\] - 2026-11-30\n\n### Changed\n\n- New flow\.\n\n## \[0\.2\.0\]/);
      assert.equal(existsSync(join(fragmentsDir(root), "738-fragments.md")), false);
      assert.equal(existsSync(join(fragmentsDir(root), "README.md")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("changes nothing when a fragment is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "envelope-changelog-"));
    try {
      mkdirSync(fragmentsDir(root), { recursive: true });
      writeFileSync(join(root, "CHANGELOG.md"), `${HEAD}\n${PREVIOUS}`);
      writeFileSync(join(fragmentsDir(root), "1-good.md"), "Added\n\n- Good.\n");
      writeFileSync(join(fragmentsDir(root), "2-bad.md"), "Security\n\n- Bad.\n");

      assert.throws(() => release(root, "0.2.1", "2026-11-30"), /2-bad\.md/);
      assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), `${HEAD}\n${PREVIOUS}`);
      assert.equal(existsSync(join(fragmentsDir(root), "1-good.md")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the repository's own fragments", () => {
  it("are all valid, and CHANGELOG.md can still take a release", () => {
    const fragments = readFragments(REPOSITORY_ROOT);
    const changelog = readFileSync(join(REPOSITORY_ROOT, "CHANGELOG.md"), "utf8");
    try {
      compileRelease({ changelog, fragments, version: "999.0.0", date: "2026-01-01" });
    } catch (error) {
      // Right after a release there is legitimately nothing to compile.
      if (!/nothing to release/.test((error as Error).message)) throw error;
    }
  });
});
