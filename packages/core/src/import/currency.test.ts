import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { parseCamt053 } from "./camt053.ts";
import { parseCsv, type CsvMapping } from "./csv.ts";
import { parseOfx } from "./ofx.ts";
import { parseQif } from "./qif.ts";

// Every import format reads its amounts in the account currency's own minor units (#671), and
// the formats that state a currency refuse a file in another one (#672).

const CSV_MAPPING: CsvMapping = {
  hasHeaderRow: false,
  dateColumn: 0,
  dateFormat: "YYYY-MM-DD",
  descriptionColumn: 1,
  amountColumn: 2,
  decimalSeparator: ".",
};

const ofx = (amounts: readonly string[], curdef?: string) =>
  "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>" +
  (curdef === undefined ? "" : `<CURDEF>${curdef}`) +
  "<BANKTRANLIST>" +
  amounts.map((amount, i) => `<STMTTRN><DTPOSTED>20260920<TRNAMT>${amount}<FITID>F${i}</STMTTRN>`).join("") +
  "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";

const camtEntry = (amount: string, ccy?: string) =>
  `<Ntry><Amt${ccy === undefined ? "" : ` Ccy="${ccy}"`}>${amount}</Amt><CdtDbtInd>DBIT</CdtDbtInd>` +
  "<BookgDt><Dt>2026-09-26</Dt></BookgDt></Ntry>";

const camt = (entries: readonly string[], accountCcy?: string) =>
  "<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>XX00</IBAN></Id>" +
  (accountCcy === undefined ? "" : `<Ccy>${accountCcy}</Ccy>`) +
  "</Acct>" +
  entries.join("") +
  "</Stmt></BkToCstmrStmt></Document>";

const amounts = (rows: readonly { amountCents: number }[]) => rows.map((row) => row.amountCents);

const mismatch = (fileCurrency: string, accountCurrency: string) => (error: unknown) =>
  isValidationError(error, "currency_mismatch") &&
  error.details.fileCurrency === fileCurrency &&
  error.details.accountCurrency === accountCurrency;

describe("imported amounts in the account currency's minor units (#671)", () => {
  it("CSV", () => {
    const content = "2026-09-15,Sale,-1000\n2026-09-16,Fee,1.500\n";
    assert.deepEqual(amounts(parseCsv(content, CSV_MAPPING, { currency: "JPY" })), [-1000, 2]);
    assert.deepEqual(amounts(parseCsv(content, CSV_MAPPING, { currency: "EUR" })), [-100_000, 150]);
    assert.deepEqual(amounts(parseCsv(content, CSV_MAPPING, { currency: "KWD" })), [-1_000_000, 1500]);
  });

  it("CSV with separate outflow and inflow columns", () => {
    const split: CsvMapping = {
      hasHeaderRow: false,
      dateColumn: 0,
      dateFormat: "YYYY-MM-DD",
      descriptionColumn: 1,
      outflowColumn: 2,
      inflowColumn: 3,
      decimalSeparator: ".",
    };
    const content = "2026-09-15,Sale,1.250,\n2026-09-16,Refund,,3\n";
    assert.deepEqual(amounts(parseCsv(content, split, { currency: "KWD" })), [-1250, 3000]);
    assert.deepEqual(amounts(parseCsv(content, split, { currency: "JPY" })), [-1, 3]);
  });

  it("QIF", () => {
    const content = "!Type:Bank\nD21/09/2026\nPA\nT-1.000,50\n^\nD22/09/2026\nPB\nT2,25\n^\n";
    assert.deepEqual(amounts(parseQif(content, {}, { currency: "JPY" })), [-1001, 2]);
    assert.deepEqual(amounts(parseQif(content, {}, { currency: "EUR" })), [-100_050, 225]);
    assert.deepEqual(amounts(parseQif(content, {}, { currency: "KWD" })), [-1_000_500, 2250]);
  });

  it("OFX", () => {
    const content = ofx(["-1500.00", "+250", "0.125"]);
    assert.deepEqual(amounts(parseOfx(content, { currency: "JPY" })), [-1500, 250, 0]);
    assert.deepEqual(amounts(parseOfx(content, { currency: "EUR" })), [-150_000, 25_000, 13]);
    assert.deepEqual(amounts(parseOfx(content, { currency: "KWD" })), [-1_500_000, 250_000, 125]);
  });

  it("CAMT.053", () => {
    const content = camt([camtEntry("1500"), camtEntry("1.500"), camtEntry("0.005")]);
    assert.deepEqual(amounts(parseCamt053(content, { currency: "JPY" })), [-1500, -2, 0]);
    assert.deepEqual(amounts(parseCamt053(content, { currency: "EUR" })), [-150_000, -150, -1]);
    assert.deepEqual(amounts(parseCamt053(content, { currency: "KWD" })), [-1_500_000, -1500, -5]);
  });

  it("CAMT.053 still refuses a signed amount: the sign is the credit/debit indicator", () => {
    assert.throws(
      () => parseCamt053(camt([camtEntry("-10.00")]), { currency: "EUR" }),
      (error: unknown) => isValidationError(error, "invalid_amount_format"),
    );
  });
});

describe("a file stating another currency than the account's (#672)", () => {
  it("OFX: refuses a CURDEF other than the account's, in either OFX version, whatever its case", () => {
    assert.throws(() => parseOfx(ofx(["-10.00"], "USD"), { currency: "EUR" }), mismatch("USD", "EUR"));
    assert.throws(() => parseOfx(ofx(["-10.00"], "usd</CURDEF>"), { currency: "EUR" }), mismatch("USD", "EUR"));
    assert.throws(() => parseOfx(ofx(["-10"], "EUR"), { currency: "JPY" }), mismatch("EUR", "JPY"));
  });

  it("OFX: refuses the whole file before reading any amount", () => {
    // A malformed amount would be invalid_amount_format: the currency is checked first.
    assert.throws(() => parseOfx(ofx(["oops"], "USD"), { currency: "EUR" }), mismatch("USD", "EUR"));
  });

  it("OFX: refuses a file of several statements when any one of them is in another currency", () => {
    const content = ofx(["-1.00"], "EUR") + ofx(["-2.00"], "USD");
    assert.throws(() => parseOfx(content, { currency: "EUR" }), mismatch("USD", "EUR"));
  });

  it("OFX: reads a file in the account's currency, or stating none, in that currency", () => {
    assert.deepEqual(amounts(parseOfx(ofx(["-10.00"], "EUR"), { currency: "EUR" })), [-1000]);
    assert.deepEqual(amounts(parseOfx(ofx(["-10.00"], "eur"), { currency: "EUR" })), [-1000]);
    assert.deepEqual(amounts(parseOfx(ofx(["-1500"], "JPY"), { currency: "JPY" })), [-1500]);
    assert.deepEqual(amounts(parseOfx(ofx(["-10.00"]), { currency: "USD" })), [-1000]);
    assert.deepEqual(amounts(parseOfx(ofx(["-10.00"], ""), { currency: "USD" })), [-1000]);
  });

  it("CAMT.053: refuses an entry's amount in another currency", () => {
    const content = camt([camtEntry("1.00", "EUR"), camtEntry("2.00", "USD")]);
    assert.throws(() => parseCamt053(content, { currency: "EUR" }), mismatch("USD", "EUR"));
    const singleQuoted = "<Ntry><Amt Ccy='GBP'>1.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-09-26</Dt></BookgDt></Ntry>";
    assert.throws(() => parseCamt053(singleQuoted, { currency: "EUR" }), mismatch("GBP", "EUR"));
  });

  it("CAMT.053: refuses a statement whose account is in another currency", () => {
    assert.throws(() => parseCamt053(camt([camtEntry("1.00")], "CHF"), { currency: "EUR" }), mismatch("CHF", "EUR"));
    assert.throws(() => parseCamt053(camt([], "CHF"), { currency: "EUR" }), mismatch("CHF", "EUR"));
  });

  it("CAMT.053: refuses the whole file before reading any entry", () => {
    const content = camt(["<Ntry><Amt>1.00</Amt></Ntry>", camtEntry("2.00", "USD")]);
    assert.throws(() => parseCamt053(content, { currency: "EUR" }), mismatch("USD", "EUR"));
  });

  it("CAMT.053: does not read the currencies of an entry's transaction details", () => {
    // The original amount of a card payment abroad, under AmtDtls, is in another currency on purpose.
    const entry =
      '<Ntry><Amt Ccy="EUR">9.20</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-09-26</Dt></BookgDt>' +
      '<NtryDtls><TxDtls><AmtDtls><InstdAmt><Amt Ccy="USD">10.00</Amt></InstdAmt></AmtDtls>' +
      "<RltdPties><CdtrAcct><Id><IBAN>US00</IBAN></Id><Ccy>USD</Ccy></CdtrAcct></RltdPties></TxDtls></NtryDtls></Ntry>";
    assert.deepEqual(amounts(parseCamt053(camt([entry], "EUR"), { currency: "EUR" })), [-920]);
  });

  it("CAMT.053: reads a file in the account's currency, or stating none, in that currency", () => {
    const content = camt([camtEntry("1500", "JPY")], "JPY");
    assert.deepEqual(amounts(parseCamt053(content, { currency: "JPY" })), [-1500]);
    assert.deepEqual(amounts(parseCamt053(camt([camtEntry("1.50")]), { currency: "KWD" })), [-1500]);
  });

  it("CSV and QIF state no currency and are never refused for one", () => {
    assert.deepEqual(amounts(parseCsv("2026-09-15,Sale,1\n", CSV_MAPPING, { currency: "CHF" })), [100]);
    assert.deepEqual(amounts(parseQif("!Type:Bank\nD21/09/2026\nT-1.50\n^\n", {}, { currency: "CHF" })), [-150]);
  });
});
