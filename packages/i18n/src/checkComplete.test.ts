import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { checkCatalogs } from "./checkComplete.ts";

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

  it("the real catalogs: en.json and it.json agree on every key and every argument (ADR 0004)", () => {
    const en = JSON.parse(readFileSync(new URL("../locales/en.json", import.meta.url), "utf-8")) as Record<string, string>;
    const it = JSON.parse(readFileSync(new URL("../locales/it.json", import.meta.url), "utf-8")) as Record<string, string>;
    const problems = checkCatalogs(en, it);
    assert.deepEqual(problems, [], `${problems.length} problem(s) between en.json and it.json:\n${problems.map((p) => `  ${p.kind} — ${p.key}${p.detail ? ` (${p.detail})` : ""}`).join("\n")}`);
  });
});
