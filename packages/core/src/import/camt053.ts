/**
 * CAMT.053 (ISO 20022) import (design.md, "Import and reconciliation"):
 * self-describing XML, no column mapping and no date/decimal ambiguity —
 * unlike OFX and QIF, ISO 20022 fixes dates as "YYYY-MM-DD" (or a full
 * timestamp starting with it) and amounts with "." as the decimal
 * separator, always a plain magnitude with the sign given separately.
 *
 * Each statement entry (`<Ntry>`) becomes one row, using its own amount and
 * credit/debit indicator; the counterparty name and remittance info come
 * from its first transaction detail (`<TxDtls>`), when the bank includes
 * one — a batched entry covering several underlying transactions is not
 * split further, the same one-row-per-statement-line granularity as
 * CSV/OFX/QIF (#28, #29, #30).
 *
 * Pure, no XML library (packages/core has no dependencies): a minimal,
 * scoped tag extractor, not a general XML parser — safe here because none
 * of the tags read ever nest inside themselves.
 */

import { ValidationError } from "../errors.ts";
import { assertCents, type Cents } from "../money.ts";
import { assertDate, type LocalDate } from "../month.ts";
import type { ImportRow } from "./row.ts";

/** The ISO 20022 convention for "no value" on an otherwise-mandatory reference field. */
const NOT_PROVIDED = "NOTPROVIDED";

function extractBlock(content: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(content);
  return match?.[1];
}

function extractAllBlocks(content: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    blocks.push(match[1] ?? "");
  }
  return blocks;
}

function extractText(content: string, tag: string): string | undefined {
  const value = extractBlock(content, tag)?.trim();
  return value ? value : undefined;
}

function extractReference(content: string, tag: string): string | undefined {
  const value = extractText(content, tag);
  return value && value !== NOT_PROVIDED ? value : undefined;
}

/** `<Dt>YYYY-MM-DD</Dt>` or `<DtTm>YYYY-MM-DDThh:mm:ss...</DtTm>`, whichever the entry gives. */
function parseCamtDate(entry: string, dateTag: string): LocalDate | undefined {
  const block = extractBlock(entry, dateTag);
  if (block === undefined) return undefined;
  const dt = extractText(block, "Dt") ?? extractText(block, "DtTm")?.slice(0, 10);
  if (!dt) return undefined;
  assertDate(dt);
  return dt;
}

function parseCamtAmount(entry: string): Cents {
  const text = extractText(entry, "Amt");
  if (!text || !/^\d+(\.\d+)?$/.test(text)) {
    throw new ValidationError("invalid_amount_format", `not a valid CAMT.053 amount: "${text ?? ""}"`, {});
  }
  const cents = Math.round(Number(text) * 100);
  assertCents(cents);
  return cents;
}

/** The other party's name: the creditor for an outgoing (debit) entry, the debtor for an incoming (credit) one. */
function extractCounterpartyName(txDtls: string | undefined, isDebit: boolean): string {
  if (!txDtls) return "";
  const partiesBlock = extractBlock(txDtls, "RltdPties");
  if (!partiesBlock) return "";
  const partyBlock = extractBlock(partiesBlock, isDebit ? "Cdtr" : "Dbtr");
  return partyBlock ? (extractText(partyBlock, "Nm") ?? "") : "";
}

/** Unstructured remittance info can repeat (each up to 140 chars per the schema); joined into one memo. */
function extractRemittanceInfo(txDtls: string | undefined): string | undefined {
  if (!txDtls) return undefined;
  const rmtInf = extractBlock(txDtls, "RmtInf");
  if (!rmtInf) return undefined;
  const parts = extractAllBlocks(rmtInf, "Ustrd")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * @throws ValidationError "invalid_camt053_entry" for an entry missing a required date, amount or
 * credit/debit indicator; "invalid_amount_format"/"invalid_date" for a malformed one.
 */
export function parseCamt053(content: string): ImportRow[] {
  const entries = extractAllBlocks(content, "Ntry");

  return entries.map((entry) => {
    const date = parseCamtDate(entry, "BookgDt") ?? parseCamtDate(entry, "ValDt");
    if (!date) {
      throw new ValidationError("invalid_camt053_entry", "a CAMT.053 entry is missing BookgDt/ValDt", {});
    }
    const cdtDbtInd = extractText(entry, "CdtDbtInd");
    if (cdtDbtInd !== "CRDT" && cdtDbtInd !== "DBIT") {
      throw new ValidationError("invalid_camt053_entry", "a CAMT.053 entry is missing a valid CdtDbtInd", {});
    }
    const magnitude = parseCamtAmount(entry);
    const amountCents = cdtDbtInd === "DBIT" ? -magnitude : magnitude;

    const externalId = extractReference(entry, "AcctSvcrRef") ?? extractReference(entry, "NtryRef");

    const ntryDtls = extractBlock(entry, "NtryDtls");
    const txDtls = ntryDtls !== undefined ? extractBlock(ntryDtls, "TxDtls") : undefined;
    const payee = extractCounterpartyName(txDtls, cdtDbtInd === "DBIT");
    const memo = extractRemittanceInfo(txDtls) ?? extractText(entry, "AddtlNtryInf");

    return { date, payee, ...(memo ? { memo } : {}), amountCents, ...(externalId ? { externalId } : {}) };
  });
}
