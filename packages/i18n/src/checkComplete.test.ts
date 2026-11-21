import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { checkCatalogs, checkMessages, checkShippedCatalogs } from "./checkComplete.ts";
import { REVIEW_STATUS, SHIPPED_LOCALES, SOURCE_LOCALE } from "./index.ts";

describe("checkCatalogs", () => {
  it("passes when both catalogs have the same keys and the same arguments", () => {
    const problems = checkCatalogs({ a: "Hello {name}" }, { a: "Ciao {name}" });
    assert.deepEqual(problems, []);
  });

  it("flags a key missing in the target catalog", () => {
    const problems = checkCatalogs({ a: "Hello", b: "Bye" }, { a: "Ciao" });
    assert.deepEqual(problems, [{ key: "b", kind: "missingInTarget" }]);
  });

  it("flags a stale key the target has but the source no longer does", () => {
    const problems = checkCatalogs({ a: "Hello" }, { a: "Ciao", old: "Vecchio" });
    assert.deepEqual(problems, [{ key: "old", kind: "staleInTarget" }]);
  });

  it("flags a dropped ICU argument in the target's own translation", () => {
    const problems = checkCatalogs({ a: "Hello {name}" }, { a: "Ciao" });
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.kind, "argumentMismatch");
  });

  it("flags a renamed ICU argument, not just a dropped one", () => {
    const problems = checkCatalogs({ a: "Hello {name}" }, { a: "Ciao {nome}" });
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.kind, "argumentMismatch");
  });

  it("looks inside a plural's own branches, not just the top-level argument", () => {
    const problems = checkCatalogs(
      { a: "{count, plural, one {# thing with {foo}} other {# things}}" },
      { a: "{count, plural, one {# cosa} other {# cose}}" },
    );
    assert.ok(problems.some((p) => p.kind === "argumentMismatch"));
  });
});

describe("checkMessages", () => {
  it("passes plurals and selects that have an other branch", () => {
    assert.deepEqual(
      checkMessages({
        a: "{count, plural, one {# thing} other {# things}}",
        b: "{kind, select, card {Card} other {Account}}",
      }),
      [],
    );
  });

  it("flags a plural without an other branch", () => {
    assert.deepEqual(
      checkMessages({ a: "{count, plural, one {# thing} few {# things}}" }).map((p) => p.kind),
      ["missingOtherBranch"],
    );
  });

  it("flags a select without an other branch, however deep it sits", () => {
    const problems = checkMessages({ a: "{count, plural, one {{kind, select, card {Card}}} other {#}}" });
    assert.deepEqual(problems.map((p) => p.kind), ["missingOtherBranch"]);
    assert.match(problems[0]!.detail ?? "", /kind/);
  });

  it("flags a message that does not parse", () => {
    assert.deepEqual(checkMessages({ a: "Hello {name" }).map((p) => p.kind), ["invalidMessage"]);
  });
});

describe("checkShippedCatalogs (#620)", () => {
  const dir = mkdtempSync(join(tmpdir(), "envelope-i18n-check-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "en.json"), JSON.stringify({ a: "Hello {name}", b: "Bye" }));
  writeFileSync(join(dir, "it.json"), JSON.stringify({ a: "Ciao {name}", b: "Arrivederci" }));
  // A translation in progress: misses a key and drops an argument.
  writeFileSync(join(dir, "de.json"), JSON.stringify({ a: "Hallo" }));

  it("ignores a catalog that is not shipped, however incomplete", () => {
    const results = checkShippedCatalogs(dir, ["en", "it"], "en");
    assert.deepEqual(results.map((r) => r.locale), ["en", "it"]);
    assert.ok(results.every((r) => r.problems.length === 0));
  });

  it("fails on the same catalog once it is shipped", () => {
    const results = checkShippedCatalogs(dir, ["en", "it", "de"], "en");
    const de = results.find((r) => r.locale === "de");
    assert.deepEqual(de?.problems.map((p) => p.kind).sort(), ["argumentMismatch", "missingInTarget"]);
  });

  it("fails on a shipped language that has no catalog file", () => {
    const results = checkShippedCatalogs(dir, ["en", "fr"], "en");
    assert.equal(results.find((r) => r.locale === "fr")?.problems.length, 1);
  });

  it("checks the source catalog's own plurals and selects too", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "envelope-i18n-check-source-"));
    try {
      writeFileSync(join(sourceDir, "en.json"), JSON.stringify({ a: "{n, plural, one {# thing}}" }));
      const results = checkShippedCatalogs(sourceDir, ["en"], "en");
      assert.deepEqual(results[0]?.problems.map((p) => p.kind), ["missingOtherBranch"]);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});

describe("SHIPPED_LOCALES", () => {
  it("lists the source language first and no language twice", () => {
    assert.equal(SHIPPED_LOCALES[0], SOURCE_LOCALE);
    assert.equal(new Set(SHIPPED_LOCALES).size, SHIPPED_LOCALES.length);
  });
});

describe("locales/index.json", () => {
  it("has a catalog file and a review status for every shipped language other than the source one", () => {
    for (const locale of SHIPPED_LOCALES.filter((l) => l !== SOURCE_LOCALE)) {
      assert.ok(existsSync(fileURLToPath(new URL(`../locales/${locale}.json`, import.meta.url))), `locales/${locale}.json is missing`);
      assert.ok(REVIEW_STATUS[locale] === "maintainer" || REVIEW_STATUS[locale] === "agent", `no review status for ${locale}`);
    }
  });
});
