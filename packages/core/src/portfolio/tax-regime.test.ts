import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import {
  isTaxRegime,
  regimeAt,
  validateAccountTaxSettings,
  validateTaxRegimeHistory,
  type TaxRegimeEntry,
} from "./tax-regime.ts";

const history: readonly TaxRegimeEntry[] = [
  { validFrom: "2027-01-01", regime: "self_declared" },
  { validFrom: "2024-03-15", regime: "administered" },
  { validFrom: "2029-01-01", regime: "managed" },
];

describe("regimeAt", () => {
  it("returns undefined for an empty history", () => {
    assert.equal(regimeAt([], "2026-06-30"), undefined);
  });

  it("returns undefined before the first entry", () => {
    assert.equal(regimeAt(history, "2024-03-14"), undefined);
  });

  it("applies an entry from its own first day, whatever the order of the history", () => {
    assert.equal(regimeAt(history, "2024-03-15"), "administered");
    assert.equal(regimeAt(history, "2026-12-31"), "administered");
    assert.equal(regimeAt(history, "2027-01-01"), "self_declared");
    assert.equal(regimeAt(history, "2028-07-01"), "self_declared");
    assert.equal(regimeAt(history, "2029-01-01"), "managed");
    assert.equal(regimeAt(history, "2040-01-01"), "managed");
  });

  it("rejects a date that is not a real calendar date", () => {
    assert.throws(() => regimeAt(history, "2026-02-30"), (error) => isValidationError(error, "invalid_date"));
  });
});

describe("validateTaxRegimeHistory", () => {
  it("accepts an empty history and a single entry on any date", () => {
    validateTaxRegimeHistory([]);
    validateTaxRegimeHistory([{ validFrom: "2025-08-19", regime: "self_declared" }]);
  });

  it("accepts later entries on 1 January, given in any order", () => {
    validateTaxRegimeHistory(history);
  });

  it("rejects a later entry that does not start on 1 January", () => {
    assert.throws(
      () =>
        validateTaxRegimeHistory([
          { validFrom: "2024-03-15", regime: "administered" },
          { validFrom: "2026-07-01", regime: "self_declared" },
        ]),
      (error) => isValidationError(error, "tax_regime_change_not_year_start") && error.details.validFrom === "2026-07-01",
    );
  });

  it("checks the earliest entry, not the first one given: an entry added before a mid-year start makes that start a change", () => {
    assert.throws(
      () =>
        validateTaxRegimeHistory([
          { validFrom: "2024-03-15", regime: "administered" },
          { validFrom: "2023-01-01", regime: "self_declared" },
        ]),
      (error) => isValidationError(error, "tax_regime_change_not_year_start") && error.details.validFrom === "2024-03-15",
    );
  });

  it("rejects two entries on the same date", () => {
    assert.throws(
      () =>
        validateTaxRegimeHistory([
          { validFrom: "2026-01-01", regime: "administered" },
          { validFrom: "2026-01-01", regime: "managed" },
        ]),
      (error) => isValidationError(error, "tax_regime_duplicate_date"),
    );
  });

  it("rejects an entry whose date is not a real calendar date", () => {
    assert.throws(
      () => validateTaxRegimeHistory([{ validFrom: "2026-13-01", regime: "managed" }]),
      (error) => isValidationError(error, "invalid_date"),
    );
  });
});

describe("isTaxRegime", () => {
  it("accepts the three regimes only", () => {
    for (const regime of ["self_declared", "administered", "managed"]) {
      assert.ok(isTaxRegime(regime));
    }
    for (const value of ["SELF_DECLARED", "", null, 1, undefined]) {
      assert.ok(!isTaxRegime(value));
    }
  });
});

describe("validateAccountTaxSettings", () => {
  it("requires both settings on a brokerage account in an IT workspace", () => {
    assert.throws(
      () => validateAccountTaxSettings({ accountType: "brokerage", taxCountry: "IT", domesticWithholdingAgent: true }),
      (error) => isValidationError(error, "tax_regime_required") && error.details.field === "taxRegime",
    );
    assert.throws(
      () => validateAccountTaxSettings({ accountType: "brokerage", taxCountry: "IT", taxRegime: "administered" }),
      (error) => isValidationError(error, "tax_regime_required") && error.details.field === "domesticWithholdingAgent",
    );
    validateAccountTaxSettings({
      accountType: "brokerage",
      taxCountry: "IT",
      taxRegime: "self_declared",
      domesticWithholdingAgent: false,
    });
  });

  it("leaves both optional on a brokerage account elsewhere, or with no tax country", () => {
    validateAccountTaxSettings({ accountType: "brokerage", taxCountry: null });
    validateAccountTaxSettings({ accountType: "brokerage", taxCountry: "FR" });
    validateAccountTaxSettings({ accountType: "brokerage", taxCountry: "FR", taxRegime: "managed" });
  });

  it("rejects either setting on an account that is not a brokerage account, whatever the country", () => {
    for (const taxCountry of ["IT", null]) {
      assert.throws(
        () => validateAccountTaxSettings({ accountType: "checking", taxCountry, taxRegime: "administered" }),
        (error) => isValidationError(error, "tax_regime_not_applicable") && error.details.field === "taxRegime",
      );
      assert.throws(
        () => validateAccountTaxSettings({ accountType: "savings", taxCountry, domesticWithholdingAgent: false }),
        (error) => isValidationError(error, "tax_regime_not_applicable") && error.details.field === "domesticWithholdingAgent",
      );
    }
    validateAccountTaxSettings({ accountType: "checking", taxCountry: "IT" });
  });
});
