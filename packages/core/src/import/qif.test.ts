import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { parseQif } from "./qif.ts";

// Shaped like a real bank download: a card payment, an incoming transfer, and a salary
// credit, each with a memo blob of bank-specific details glued together as free text.
const REALISTIC_FIXTURE = `!Type:Bank
D21/09/2026
PCard payment
MPOS purchase ref 12345 merchant ACME SRL amount -50.00 fee 0.00 card 1234
T-50,00
^
D17/09/2026
PIncoming transfer
MTransfer received via instant channel ref A1B2C3 from Jane Doe iban IT00X0000000000000000000000
T300,00
^
D02/09/2026
PSalary
MMonthly salary Example Corp
T1500,00
^
`;

describe("parseQif", () => {
  it("parses a realistic file, inferring DD/MM/YYYY and a comma decimal separator from its own data", () => {
    const rows = parseQif(REALISTIC_FIXTURE);
    assert.deepEqual(rows, [
      {
        date: "2026-09-21",
        payee: "Card payment",
        memo: "POS purchase ref 12345 merchant ACME SRL amount -50.00 fee 0.00 card 1234",
        amountCents: -5000,
      },
      {
        date: "2026-09-17",
        payee: "Incoming transfer",
        memo: "Transfer received via instant channel ref A1B2C3 from Jane Doe iban IT00X0000000000000000000000",
        amountCents: 30000,
      },
      { date: "2026-09-02", payee: "Salary", memo: "Monthly salary Example Corp", amountCents: 150000 },
    ]);
  });

  it("asks for a dateFormat hint when every date could be either DD/MM or MM/DD", () => {
    const content = "!Type:Bank\nD05/06/2026\nPA\nT-10,00\n^\nD07/08/2026\nPB\nT-20,00\n^\n";
    assert.throws(
      () => parseQif(content),
      (error: unknown) => isValidationError(error, "ambiguous_date_format"),
    );
  });

  it("accepts an explicit dateFormat hint instead of guessing", () => {
    const content = "!Type:Bank\nD05/06/2026\nPA\nT-10,00\n^\n";
    const rows = parseQif(content, { dateFormat: "MM/DD/YYYY" });
    assert.equal(rows[0]?.date, "2026-05-06");
  });

  it("asks for a decimalSeparator hint when no amount has a clean two-digit tail", () => {
    const content = "!Type:Bank\nD21/09/2026\nPA\nT-10\n^\nD22/09/2026\nPB\nT20\n^\n";
    assert.throws(
      () => parseQif(content),
      (error: unknown) => isValidationError(error, "ambiguous_decimal_separator"),
    );
  });

  it("accepts an explicit decimalSeparator hint instead of guessing", () => {
    const content = "!Type:Bank\nD21/09/2026\nPA\nT-10\n^\n";
    const rows = parseQif(content, { decimalSeparator: "." });
    assert.equal(rows[0]?.amountCents, -1000);
  });

  it("rejects a transaction block missing its amount", () => {
    const content = "!Type:Bank\nD21/09/2026\nPA\nT-10,00\n^\nD22/09/2026\nPB\n^\n";
    assert.throws(
      () => parseQif(content),
      (error: unknown) => isValidationError(error, "invalid_qif_transaction"),
    );
  });

  it("rejects a malformed date", () => {
    // A first, well-formed transaction settles the date format heuristic (day 21 > 12); the second's date is malformed.
    const content = "!Type:Bank\nD21/09/2026\nPA\nT-10,00\n^\nDnot-a-date\nPB\nT-20,00\n^\n";
    assert.throws(
      () => parseQif(content),
      (error: unknown) => isValidationError(error, "invalid_date"),
    );
  });

  it("rejects a malformed amount", () => {
    // A first, well-formed transaction settles the decimal separator heuristic; the second's amount is malformed.
    const content = "!Type:Bank\nD21/09/2026\nPA\nT-10,00\n^\nD22/09/2026\nPB\nTnot-a-number\n^\n";
    assert.throws(
      () => parseQif(content),
      (error: unknown) => isValidationError(error, "invalid_amount_format"),
    );
  });

  it("returns an empty array for a file with no transactions", () => {
    assert.deepEqual(parseQif("!Type:Bank\n"), []);
  });
});
