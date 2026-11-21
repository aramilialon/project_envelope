import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { MAX_AMOUNT_CENTS } from "../money.ts";
import { parseCamt053 } from "./camt053.ts";
import { parseCsv, type CsvMapping } from "./csv.ts";
import { parseOfx } from "./ofx.ts";
import { parseQif } from "./qif.ts";

// Every import format applies the cap on a single amount (#651, ADR 0002): the cap itself is
// read, one cent more refused with "amount_too_large" and the cap in `details.max`. The figures
// are derived from `MAX_AMOUNT_CENTS`, so they follow it.
const tooLarge = (error: unknown) => isValidationError(error, "amount_too_large") && error.details.max === MAX_AMOUNT_CENTS;

const AT_CAP = (MAX_AMOUNT_CENTS / 100).toFixed(2);
const OVER_CAP = ((MAX_AMOUNT_CENTS + 1) / 100).toFixed(2);
const itIT = (minorUnits: number): string =>
  new Intl.NumberFormat("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minorUnits / 100);

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
    assert.equal(parseCsv(`2026-09-15,Sale,${AT_CAP}\n`, CSV_MAPPING)[0]?.amountCents, MAX_AMOUNT_CENTS);
    assert.throws(() => parseCsv(`2026-09-15,Sale,${OVER_CAP}\n`, CSV_MAPPING), tooLarge);
  });

  it("OFX", () => {
    assert.equal(parseOfx(ofx(`-${AT_CAP}`))[0]?.amountCents, -MAX_AMOUNT_CENTS);
    assert.throws(() => parseOfx(ofx(`-${OVER_CAP}`)), tooLarge);
  });

  it("CAMT.053", () => {
    assert.equal(parseCamt053(camt(AT_CAP))[0]?.amountCents, MAX_AMOUNT_CENTS);
    assert.throws(() => parseCamt053(camt(OVER_CAP)), tooLarge);
  });

  it("QIF", () => {
    assert.equal(parseQif(qif(itIT(MAX_AMOUNT_CENTS)))[1]?.amountCents, MAX_AMOUNT_CENTS);
    assert.throws(() => parseQif(qif(itIT(MAX_AMOUNT_CENTS + 1))), tooLarge);
  });
});
