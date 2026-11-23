import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import {
  assertWithholdingAgentFor,
  isTaxRegime,
  regimeAt,
  validateAccountTaxSettings,
  validateTaxRegimeChange,
  validateTaxRegimeHistory,
  validateWithholdingAgentChange,
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

  it("applies the first entry to every date before it, whatever the order of the history", () => {
    assert.equal(regimeAt(history, "2024-03-14"), "administered");
    assert.equal(regimeAt(history, "1999-01-01"), "administered");
    assert.equal(regimeAt([{ validFrom: "2026-11-20", regime: "managed" }], "2020-06-30"), "managed");
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

  describe("with the entries a request adds to a stored history (#714)", () => {
    const stored: readonly TaxRegimeEntry[] = [
      { validFrom: "2024-03-15", regime: "administered" },
      { validFrom: "2027-01-01", regime: "self_declared" },
    ];
    const names = (requested: TaxRegimeEntry, validFrom: string) => () =>
      assert.throws(
        () => validateTaxRegimeHistory([...stored, requested], [requested]),
        (error) => isValidationError(error, "tax_regime_change_not_year_start") && error.details.validFrom === validFrom,
      );

    it("names the requested date when the new entry comes first and makes the stored first one a change", () => {
      names({ validFrom: "2023-06-01", regime: "self_declared" }, "2023-06-01")();
      // On 1 January too: the stored first entry is what breaks the rule, the request what moved it.
      names({ validFrom: "2023-01-01", regime: "self_declared" }, "2023-01-01")();
      // A whole history replaced at once names the entry that breaks the rule, as before.
      assert.throws(
        () => validateTaxRegimeHistory([...stored, { validFrom: "2023-06-01", regime: "self_declared" }]),
        (error) => isValidationError(error, "tax_regime_change_not_year_start") && error.details.validFrom === "2024-03-15",
      );
    });

    it("names the requested date in the middle and last", () => {
      names({ validFrom: "2025-07-01", regime: "managed" }, "2025-07-01")();
      names({ validFrom: "2028-07-01", regime: "managed" }, "2028-07-01")();
    });

    it("accepts a new first entry before a stored first one that starts on 1 January", () => {
      const yearStart: readonly TaxRegimeEntry[] = [{ validFrom: "2024-01-01", regime: "administered" }];
      const requested: TaxRegimeEntry = { validFrom: "2023-06-01", regime: "self_declared" };
      validateTaxRegimeHistory([...yearStart, requested], [requested]);
      validateTaxRegimeHistory([...stored, { validFrom: "2026-01-01", regime: "managed" }], [{ validFrom: "2026-01-01", regime: "managed" }]);
    });

    it("names the requested date through validateTaxRegimeChange", () => {
      const requested: TaxRegimeEntry = { validFrom: "2023-06-01", regime: "self_declared" };
      assert.throws(
        () => validateTaxRegimeChange({ taxCountry: "IT", domesticWithholdingAgent: true, history: [...stored, requested], requested: [requested] }),
        (error) => isValidationError(error, "tax_regime_change_not_year_start") && error.details.validFrom === "2023-06-01",
      );
    });
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

  it("needs no setting on a brokerage account elsewhere, or with no tax country, and refuses the Italian ones there", () => {
    validateAccountTaxSettings({ accountType: "brokerage", taxCountry: null });
    validateAccountTaxSettings({ accountType: "brokerage", taxCountry: "FR" });
    assert.throws(
      () => validateAccountTaxSettings({ accountType: "brokerage", taxCountry: "FR", taxRegime: "managed" }),
      (error) =>
        isValidationError(error, "tax_regime_not_applicable") &&
        error.details.field === "taxRegime" &&
        error.details.taxCountry === "FR",
    );
    assert.throws(
      () => validateAccountTaxSettings({ accountType: "brokerage", taxCountry: null, domesticWithholdingAgent: true }),
      (error) =>
        isValidationError(error, "tax_regime_not_applicable") &&
        error.details.field === "domesticWithholdingAgent" &&
        error.details.taxCountry === "",
    );
  });

  it("needs an Italian withholding agent for an administered or managed regime, not for a self-declared one", () => {
    for (const taxRegime of ["administered", "managed"] as const) {
      assert.throws(
        () => validateAccountTaxSettings({ accountType: "brokerage", taxCountry: "IT", taxRegime, domesticWithholdingAgent: false }),
        (error) => isValidationError(error, "tax_regime_requires_withholding_agent") && error.details.regime === taxRegime,
      );
      validateAccountTaxSettings({ accountType: "brokerage", taxCountry: "IT", taxRegime, domesticWithholdingAgent: true });
    }
    validateAccountTaxSettings({
      accountType: "brokerage",
      taxCountry: "IT",
      taxRegime: "self_declared",
      domesticWithholdingAgent: false,
    });
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

describe("assertWithholdingAgentFor", () => {
  it("refuses administered or managed anywhere in the history without the flag set to true", () => {
    for (const flag of [false, null, undefined]) {
      assert.throws(
        () => assertWithholdingAgentFor(["self_declared", "administered"], flag),
        (error) => isValidationError(error, "tax_regime_requires_withholding_agent") && error.details.regime === "administered",
      );
      assert.throws(
        () => assertWithholdingAgentFor(["managed"], flag),
        (error) => isValidationError(error, "tax_regime_requires_withholding_agent") && error.details.regime === "managed",
      );
      assertWithholdingAgentFor(["self_declared"], flag);
    }
    assertWithholdingAgentFor(["self_declared", "administered", "managed"], true);
  });
});

describe("validateTaxRegimeChange", () => {
  const corrected: readonly TaxRegimeEntry[] = [
    { validFrom: "2015-06-01", regime: "self_declared" },
    { validFrom: "2024-01-01", regime: "administered" },
  ];

  it("accepts a corrected history in an IT workspace, which then decides older dates", () => {
    validateTaxRegimeChange({ taxCountry: "IT", domesticWithholdingAgent: true, history: corrected });
    assert.equal(regimeAt(corrected, "2019-05-10"), "self_declared");
    assert.equal(regimeAt(corrected, "2024-05-10"), "administered");
  });

  it("refuses regimes outside an IT workspace, and an empty history in one", () => {
    assert.throws(
      () => validateTaxRegimeChange({ taxCountry: "FR", domesticWithholdingAgent: true, history: corrected }),
      (error) => isValidationError(error, "tax_regime_not_applicable") && error.details.taxCountry === "FR",
    );
    validateTaxRegimeChange({ taxCountry: null, domesticWithholdingAgent: null, history: [] });
    assert.throws(
      () => validateTaxRegimeChange({ taxCountry: "IT", domesticWithholdingAgent: true, history: [] }),
      (error) => isValidationError(error, "tax_regime_required"),
    );
  });

  it("applies the history rules and the withholding-agent rule", () => {
    assert.throws(
      () =>
        validateTaxRegimeChange({
          taxCountry: "IT",
          domesticWithholdingAgent: true,
          history: [...corrected, { validFrom: "2025-07-01", regime: "managed" }],
        }),
      (error) => isValidationError(error, "tax_regime_change_not_year_start"),
    );
    assert.throws(
      () => validateTaxRegimeChange({ taxCountry: "IT", domesticWithholdingAgent: false, history: corrected }),
      (error) => isValidationError(error, "tax_regime_requires_withholding_agent"),
    );
  });
});

describe("validateWithholdingAgentChange", () => {
  it("lets the flag be set once, on a brokerage account in an IT workspace that has none", () => {
    validateWithholdingAgentChange({ accountType: "brokerage", taxCountry: "IT", current: null });
    for (const current of [true, false]) {
      assert.throws(
        () => validateWithholdingAgentChange({ accountType: "brokerage", taxCountry: "IT", current }),
        (error) => isValidationError(error, "withholding_agent_already_set"),
      );
    }
    assert.throws(
      () => validateWithholdingAgentChange({ accountType: "checking", taxCountry: "IT", current: null }),
      (error) => isValidationError(error, "tax_regime_not_applicable") && error.details.type === "checking",
    );
    assert.throws(
      () => validateWithholdingAgentChange({ accountType: "brokerage", taxCountry: null, current: null }),
      (error) => isValidationError(error, "tax_regime_not_applicable") && error.details.taxCountry === "",
    );
  });
});
