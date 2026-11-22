import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isAssignedCountryCode, ISO_3166_1_ALPHA2_CODES } from "./country.ts";

describe("ISO_3166_1_ALPHA2_CODES", () => {
  it("holds the 249 assigned codes, upper case, sorted, each once", () => {
    assert.equal(ISO_3166_1_ALPHA2_CODES.length, 249);
    assert.equal(new Set(ISO_3166_1_ALPHA2_CODES).size, 249);
    assert.deepEqual([...ISO_3166_1_ALPHA2_CODES].sort(), ISO_3166_1_ALPHA2_CODES);
    for (const code of ISO_3166_1_ALPHA2_CODES) assert.match(code, /^[A-Z]{2}$/);
  });

  it("names only regions the runtime knows, so a typo in the list shows up", () => {
    const regions = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
    for (const code of ISO_3166_1_ALPHA2_CODES) assert.notEqual(regions.of(code), undefined, code);
  });

  it("cannot be changed at run time", () => {
    assert.throws(() => (ISO_3166_1_ALPHA2_CODES as string[]).push("ZZ"), TypeError);
  });
});

describe("isAssignedCountryCode (#711)", () => {
  it("accepts assigned codes", () => {
    for (const code of ["IT", "DE", "FR", "GB", "US", "AX", "SS", "BQ", "CW", "SX"]) {
      assert.equal(isAssignedCountryCode(code), true, code);
    }
  });

  it("refuses user-assigned, reserved and withdrawn codes that Intl still names", () => {
    // ZZ, QO, XA, XB, XK: user-assigned; EU, EZ, UN, UK, AC, CP, DG, EA, IC, TA: exceptionally
    // reserved; CS, SU, YU, AN: withdrawn.
    const refused = ["ZZ", "QO", "XA", "XB", "XK", "EU", "EZ", "UN", "UK", "AC", "CP", "DG", "EA", "IC", "TA", "CS", "SU", "YU", "AN"];
    for (const code of refused) {
      assert.equal(isAssignedCountryCode(code), false, code);
    }
  });

  it("refuses lower case, other shapes and non-strings", () => {
    for (const value of ["it", "It", "ITA", "I", "", " IT", "IT ", "380", undefined, null, 380]) {
      assert.equal(isAssignedCountryCode(value), false, String(value));
    }
  });
});
