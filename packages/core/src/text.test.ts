import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "./errors.ts";
import { assertTextLength, MAX_FREE_TEXT_LENGTH, MAX_NAME_LENGTH, textLength } from "./text.ts";

describe("text length", () => {
  it("names the limits", () => {
    assert.equal(MAX_NAME_LENGTH, 100);
    assert.equal(MAX_FREE_TEXT_LENGTH, 500);
  });

  it("counts code points, not UTF-16 code units", () => {
    assert.equal(textLength(""), 0);
    assert.equal(textLength("abc"), 3);
    assert.equal(textLength("caffè"), 5);
    // One code point outside the Basic Multilingual Plane is two UTF-16 code units.
    assert.equal("💶".length, 2);
    assert.equal(textLength("💶"), 1);
  });

  it("accepts a value of exactly the maximum length", () => {
    assert.doesNotThrow(() => assertTextLength("a".repeat(MAX_NAME_LENGTH), MAX_NAME_LENGTH, "name"));
    assert.doesNotThrow(() => assertTextLength("a".repeat(MAX_FREE_TEXT_LENGTH), MAX_FREE_TEXT_LENGTH, "memo"));
  });

  it("rejects a value one code point over the maximum, with a stable code and details", () => {
    assert.throws(
      () => assertTextLength("a".repeat(MAX_NAME_LENGTH + 1), MAX_NAME_LENGTH, "name"),
      (error: unknown) => {
        assert.ok(isValidationError(error, "text_too_long"));
        assert.deepEqual(error.details, { field: "name", max: MAX_NAME_LENGTH });
        return true;
      },
    );
  });

  it("measures the maximum in code points even when the UTF-16 length is over it", () => {
    const value = "💶".repeat(MAX_NAME_LENGTH);
    assert.equal(value.length, MAX_NAME_LENGTH * 2);
    assert.doesNotThrow(() => assertTextLength(value, MAX_NAME_LENGTH, "name"));
    assert.throws(
      () => assertTextLength(`${value}💶`, MAX_NAME_LENGTH, "name"),
      (error: unknown) => isValidationError(error, "text_too_long"),
    );
  });
});
