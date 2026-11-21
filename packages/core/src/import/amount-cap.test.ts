import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { MAX_AMOUNT_CENTS } from "../money.ts";
import { parseCamt053 } from "./camt053.ts";
import { parseCsv, type CsvMapping } from "./csv.ts";
import { parseOfx } from "./ofx.ts";
import { parseQif } from "./qif.ts";

// Every import format applies the cap on a single amount (#651, ADR 0002): 1000000000.00 is
// read, 1000000000.01 refused with "amount_too_large" and the cap in `details.max`.
const tooLarge = (error: unknown) => isValidationError(error, "amount_too_large") && error.details.max === MAX_AMOUNT_CENTS;

const CSV_MAPPING: CsvMapping = {
  hasHeaderRow: false,
  dateColumn: 0,
  dateFormat: "YYYY-MM-DD",
  descriptionColumn: 1,
  amountColumn: 2,
  decimalSeparator: ".",
};

const ofx = (amount: string) =>
  "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>" +
  "<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260920000000</DTPOSTED>" +
  `<TRNAMT>${amount}</TRNAMT><FITID>abc</FITID><NAME>Sale</NAME></STMTTRN>` +
  "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";

const camt = (amount: string) => `<Ntry><Amt>${amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-09-26</Dt></BookgDt></Ntry>`;

const qif = (amount: string) => `!Type:Bank\nD21/09/2026\nPA\nT-10,00\n^\nD22/09/2026\nPB\nT${amount}\n^\n`;

describe("imported amounts and the cap (#651)", () => {
  it("CSV", () => {
    assert.equal(parseCsv("2026-09-15,Sale,1000000000.00\n", CSV_MAPPING)[0]?.amountCents, MAX_AMOUNT_CENTS);
    assert.throws(() => parseCsv("2026-09-15,Sale,1000000000.01\n", CSV_MAPPING), tooLarge);
  });

  it("OFX", () => {
    assert.equal(parseOfx(ofx("-1000000000.00"))[0]?.amountCents, -MAX_AMOUNT_CENTS);
    assert.throws(() => parseOfx(ofx("-1000000000.01")), tooLarge);
  });

  it("CAMT.053", () => {
    assert.equal(parseCamt053(camt("1000000000.00"))[0]?.amountCents, MAX_AMOUNT_CENTS);
    assert.throws(() => parseCamt053(camt("1000000000.01")), tooLarge);
  });

  it("QIF", () => {
    assert.equal(parseQif(qif("1.000.000.000,00"))[1]?.amountCents, MAX_AMOUNT_CENTS);
    assert.throws(() => parseQif(qif("1.000.000.000,01")), tooLarge);
  });
});
