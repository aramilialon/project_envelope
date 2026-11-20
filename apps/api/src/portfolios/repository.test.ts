import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPortfolioNameConflict } from "./repository.ts";

// No database needed: the real error shape is checked against PostgreSQL in src/db/schema.test.ts.
describe("isPortfolioNameConflict", () => {
  it("recognises a unique violation of the active-name index", () => {
    assert.equal(isPortfolioNameConflict({ code: "23505", constraint: "portfolios_active_name_idx" }), true);
    assert.equal(
      isPortfolioNameConflict(Object.assign(new Error("duplicate key"), { code: "23505", constraint: "portfolios_active_name_idx" })),
      true,
    );
  });

  it("ignores a unique violation of any other constraint", () => {
    assert.equal(isPortfolioNameConflict({ code: "23505", constraint: "portfolios_pkey" }), false);
    assert.equal(isPortfolioNameConflict({ code: "23505", constraint: "portfolios_workspace_id_id_key" }), false);
    assert.equal(isPortfolioNameConflict({ code: "23505" }), false);
  });

  it("ignores another error code on the same constraint", () => {
    assert.equal(isPortfolioNameConflict({ code: "23503", constraint: "portfolios_active_name_idx" }), false);
    assert.equal(isPortfolioNameConflict({ constraint: "portfolios_active_name_idx" }), false);
  });

  it("ignores anything that is not an object", () => {
    for (const value of [undefined, null, "23505", 23505, true]) {
      assert.equal(isPortfolioNameConflict(value), false);
    }
  });
});
