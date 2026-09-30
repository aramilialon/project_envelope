import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidationError } from "../errors.ts";
import { parseCamt053 } from "./camt053.ts";

// Shaped like a real camt.053.001.02 statement: a salary credit and a card debit, each with
// their counterparty and remittance info under the entry's first transaction detail.
const REALISTIC_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Acct><Id><IBAN>IT00X0000000000000000000000</IBAN></Id></Acct>
      <Bal>
        <Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">1000.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
      </Bal>
      <Ntry>
        <Amt Ccy="EUR">1500.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-09-02</Dt></BookgDt>
        <AcctSvcrRef>CAMT-REF-1</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <RltdPties><Dbtr><Nm>Example Employer Srl</Nm></Dbtr></RltdPties>
            <RmtInf><Ustrd>Monthly salary</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">42.50</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-09-15</Dt></BookgDt>
        <AcctSvcrRef>CAMT-REF-2</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <RltdPties><Cdtr><Nm>Grocery Store</Nm></Cdtr></RltdPties>
            <RmtInf><Ustrd>Weekly</Ustrd><Ustrd>groceries</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>
`;

describe("parseCamt053", () => {
  it("parses a realistic statement's entries", () => {
    const rows = parseCamt053(REALISTIC_FIXTURE);
    assert.deepEqual(rows, [
      {
        date: "2026-09-02",
        payee: "Example Employer Srl",
        memo: "Monthly salary",
        amountCents: 150000,
        externalId: "CAMT-REF-1",
      },
      {
        date: "2026-09-15",
        payee: "Grocery Store",
        memo: "Weekly groceries",
        amountCents: -4250,
        externalId: "CAMT-REF-2",
      },
    ]);
  });

  it("reads a DtTm timestamp when there is no plain Dt", () => {
    const content =
      "<Ntry><Amt>10.00</Amt><CdtDbtInd>CRDT</CdtDbtInd>" +
      "<BookgDt><DtTm>2026-09-20T14:30:00</DtTm></BookgDt></Ntry>";
    const rows = parseCamt053(content);
    assert.equal(rows[0]?.date, "2026-09-20");
  });

  it("falls back to ValDt when BookgDt is absent", () => {
    const content = "<Ntry><Amt>10.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><ValDt><Dt>2026-09-21</Dt></ValDt></Ntry>";
    const rows = parseCamt053(content);
    assert.equal(rows[0]?.date, "2026-09-21");
  });

  it("falls back to AddtlNtryInf and an empty payee when there is no transaction detail", () => {
    const content =
      "<Ntry><Amt>5.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-09-22</Dt></BookgDt>" +
      "<AddtlNtryInf>Bank fee</AddtlNtryInf></Ntry>";
    const rows = parseCamt053(content);
    assert.equal(rows[0]?.payee, "");
    assert.equal(rows[0]?.memo, "Bank fee");
  });

  it('treats "NOTPROVIDED" as no reference at all, not a real external id', () => {
    const content =
      "<Ntry><Amt>5.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-09-23</Dt></BookgDt>" +
      "<NtryRef>NOTPROVIDED</NtryRef></Ntry>";
    const rows = parseCamt053(content);
    assert.equal(rows[0]?.externalId, undefined);
  });

  it("falls back to NtryRef when AcctSvcrRef is absent", () => {
    const content =
      "<Ntry><Amt>5.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-09-24</Dt></BookgDt>" +
      "<NtryRef>REF-24</NtryRef></Ntry>";
    const rows = parseCamt053(content);
    assert.equal(rows[0]?.externalId, "REF-24");
  });

  it("rejects an entry missing both BookgDt and ValDt", () => {
    const content = "<Ntry><Amt>5.00</Amt><CdtDbtInd>DBIT</CdtDbtInd></Ntry>";
    assert.throws(
      () => parseCamt053(content),
      (error: unknown) => isValidationError(error, "invalid_camt053_entry"),
    );
  });

  it("rejects an entry missing a valid CdtDbtInd", () => {
    const content = "<Ntry><Amt>5.00</Amt><BookgDt><Dt>2026-09-25</Dt></BookgDt></Ntry>";
    assert.throws(
      () => parseCamt053(content),
      (error: unknown) => isValidationError(error, "invalid_camt053_entry"),
    );
  });

  it("rejects a malformed amount", () => {
    const content = "<Ntry><Amt>-not-a-number</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-09-26</Dt></BookgDt></Ntry>";
    assert.throws(
      () => parseCamt053(content),
      (error: unknown) => isValidationError(error, "invalid_amount_format"),
    );
  });

  it("returns an empty array for a statement with no entries", () => {
    assert.deepEqual(parseCamt053("<Document><BkToCstmrStmt><Stmt></Stmt></BkToCstmrStmt></Document>"), []);
  });
});
