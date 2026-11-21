import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_AMOUNT_CENTS } from "../money.ts";
import { parseAssignedEntry } from "./assignedEntry.ts";

const en = { locale: "en-US", currency: "EUR" };
const it_ = { locale: "it-IT", currency: "EUR" };

describe("parseAssignedEntry", () => {
  it("reads a plain amount as the new assigned amount", () => {
    assert.deepEqual(parseAssignedEntry("300", 10_000, en), { ok: true, delta: 20_000, newAssigned: 30_000, isAbsolute: true });
    assert.deepEqual(parseAssignedEntry(" 50.5 ", 10_000, en), { ok: true, delta: -4_950, newAssigned: 5_050, isAbsolute: true });
  });

  it("reads '+' and '-' as a change to the current amount", () => {
    assert.deepEqual(parseAssignedEntry("+50", 10_000, en), { ok: true, delta: 5_000, newAssigned: 15_000, isAbsolute: false });
    assert.deepEqual(parseAssignedEntry("-15", 10_000, en), { ok: true, delta: -1_500, newAssigned: 8_500, isAbsolute: false });
    assert.deepEqual(parseAssignedEntry("-1500", 10_000, en), { ok: true, delta: -150_000, newAssigned: -140_000, isAbsolute: false });
  });

  it("reports an entry that changes nothing as a zero delta", () => {
    assert.deepEqual(parseAssignedEntry("100.00", 10_000, en), { ok: true, delta: 0, newAssigned: 10_000, isAbsolute: true });
    assert.deepEqual(parseAssignedEntry("+0", 10_000, en), { ok: true, delta: 0, newAssigned: 10_000, isAbsolute: false });
  });

  it("follows the locale's separators", () => {
    assert.deepEqual(parseAssignedEntry("1.234,56", 0, it_), { ok: true, delta: 123_456, newAssigned: 123_456, isAbsolute: true });
    assert.deepEqual(parseAssignedEntry("+0,50", 100, it_), { ok: true, delta: 50, newAssigned: 150, isAbsolute: false });
    assert.deepEqual(parseAssignedEntry("1,234.56", 0, en), { ok: true, delta: 123_456, newAssigned: 123_456, isAbsolute: true });
    assert.deepEqual(parseAssignedEntry("1.234,56", 0, en), { ok: false, code: "invalid_amount_format" });
  });

  it("refuses what is not an amount, a lone or doubled sign included", () => {
    for (const text of ["", "  ", "abc", "+", "-", "+-5", "--5", "12.345"]) {
      assert.deepEqual(parseAssignedEntry(text, 0, en), { ok: false, code: "invalid_amount_format" }, text);
    }
  });

  it("refuses an absolute amount above the cap", () => {
    assert.deepEqual(parseAssignedEntry("10000000000.01", 0, en), { ok: false, code: "amount_too_large" });
    assert.equal(parseAssignedEntry("10000000000", 0, en).ok, true);
  });

  it("refuses a relative entry whose result is above the cap, even when the entry itself is small", () => {
    assert.deepEqual(parseAssignedEntry("+0.01", MAX_AMOUNT_CENTS, en), { ok: false, code: "amount_too_large" });
    assert.deepEqual(parseAssignedEntry("-0.01", -MAX_AMOUNT_CENTS, en), { ok: false, code: "amount_too_large" });
  });

  it("refuses a change larger than the cap, even when the result is within it", () => {
    assert.deepEqual(parseAssignedEntry("6000000000", -600_000_000_000, en), { ok: false, code: "amount_too_large" });
  });

  it("still lets an amount stored above the cap be brought down", () => {
    const stored = 5 * MAX_AMOUNT_CENTS;
    assert.deepEqual(parseAssignedEntry("-10000000000", stored, en), {
      ok: true,
      delta: -MAX_AMOUNT_CENTS,
      newAssigned: stored - MAX_AMOUNT_CENTS,
      isAbsolute: false,
    });
    assert.deepEqual(parseAssignedEntry("+0.01", stored, en), { ok: false, code: "amount_too_large" });
  });

  it("works in whole units for a currency with no decimals", () => {
    assert.deepEqual(parseAssignedEntry("+500", 1_000, { locale: "en-US", currency: "JPY" }), {
      ok: true,
      delta: 500,
      newAssigned: 1_500,
      isAbsolute: false,
    });
  });
});
