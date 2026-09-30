import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { parseOfx } from "./ofx.ts";

// A generic OFX 1.02 (SGML) bank statement download, shaped like a real one:
// most tags are never closed, ending only at the next tag or line break.
const SGML_FIXTURE = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20260930120000
<LANGUAGE>ENG
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>EUR
<BANKACCTFROM>
<BANKID>00000000
<ACCTID>0000000000
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260901000000
<DTEND>20260930000000
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260915120000[+1:CET]
<TRNAMT>-42.50
<FITID>2026091500001
<NAME>Grocery store
<MEMO>Weekly shopping
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260916080000[+1:CET]
<TRNAMT>1000.00
<FITID>2026091600002
<NAME>Salary
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>5000.00
<DTASOF>20260930120000
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

describe("parseOfx", () => {
  it("parses a real bank statement download's transactions", () => {
    const rows = parseOfx(SGML_FIXTURE);
    assert.deepEqual(rows, [
      {
        date: "2026-09-15",
        payee: "Grocery store",
        memo: "Weekly shopping",
        amountCents: -4250,
        externalId: "2026091500001",
      },
      { date: "2026-09-16", payee: "Salary", amountCents: 100000, externalId: "2026091600002" },
    ]);
  });

  it("also reads OFX 2.x's closed XML tags", () => {
    const content =
      "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>" +
      "<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260920000000</DTPOSTED>" +
      "<TRNAMT>-10.00</TRNAMT><FITID>abc</FITID><NAME>Coffee</NAME></STMTTRN>" +
      "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";
    const rows = parseOfx(content);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.date, "2026-09-20");
    assert.equal(rows[0]?.amountCents, -1000);
    assert.equal(rows[0]?.externalId, "abc");
  });

  it("rejects a transaction missing DTPOSTED or TRNAMT", () => {
    const content = "<OFX><STMTTRN><FITID>1</FITID><NAME>Bad row</NAME></STMTTRN></OFX>";
    assert.throws(
      () => parseOfx(content),
      (error: unknown) => isValidationError(error, "invalid_ofx_transaction"),
    );
  });

  it("rejects a malformed DTPOSTED", () => {
    const content = "<OFX><STMTTRN><DTPOSTED>not-a-date</DTPOSTED><TRNAMT>-1.00</TRNAMT></STMTTRN></OFX>";
    assert.throws(
      () => parseOfx(content),
      (error: unknown) => isValidationError(error, "invalid_date"),
    );
  });

  it("returns an empty array for a file with no transactions", () => {
    assert.deepEqual(parseOfx("<OFX></OFX>"), []);
  });
});
