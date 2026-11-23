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
 * of the tags read ever nest inside themselves. The extractor scans in
 * linear time, whatever the file holds (`tag-blocks.ts`, #675).
 */

import { ValidationError } from "../errors.ts";
import type { Cents, CurrencyCode } from "../money.ts";
import { assertDate, type LocalDate } from "../month.ts";
import { assertFileCurrency, scaleDecimalAmount } from "./parsing.ts";
import type { ImportOptions, ImportRow } from "./row.ts";
import { findTagBlocks, findTagElements } from "./tag-blocks.ts";

/** The ISO 20022 convention for "no value" on an otherwise-mandatory reference field. */
const NOT_PROVIDED = "NOTPROVIDED";

function extractBlock(content: string, tag: string): string | undefined {
  return findTagBlocks(content, tag, { attributes: true, limit: 1 })[0];
}

function extractAllBlocks(content: string, tag: string): string[] {
  return findTagBlocks(content, tag, { attributes: true });
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

function parseCamtAmount(entry: string, currency: CurrencyCode): Cents {
  const text = extractText(entry, "Amt");
  // A plain magnitude: the sign is the entry's credit/debit indicator, never a "-".
  const amount = text === undefined || text.startsWith("-") ? null : scaleDecimalAmount(text, currency);
  if (amount === null) {
    throw new ValidationError("invalid_amount_format", `not a valid CAMT.053 amount: "${text ?? ""}"`, {});
  }
  return amount;
}

/** The `Ccy` attribute of an opening tag's attribute text (` Ccy="EUR"`), when it has one. */
function ccyAttribute(attributes: string): string | undefined {
  const match = /(?:^|\s)Ccy\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attributes);
  return match ? (match[1] ?? match[2]) : undefined;
}

/**
 * Every currency the file states for the money it imports: each statement's account currency
 * (`<Stmt><Acct><Ccy>`) and each entry's own amount currency (`<Ntry><Amt Ccy="…">`, the entry's
 * first `<Amt>`; the amounts under its transaction details, which may be the original amount in
 * another currency, are not read).
 */
function statedCurrencies(content: string, entries: readonly string[]): string[] {
  const currencies: string[] = [];
  for (const statement of extractAllBlocks(content, "Stmt")) {
    const account = extractBlock(statement, "Acct");
    const accountCurrency = account === undefined ? undefined : extractText(account, "Ccy");
    if (accountCurrency !== undefined) currencies.push(accountCurrency);
  }
  for (const entry of entries) {
    const amount = findTagElements(entry, "Amt", { attributes: true, limit: 1 })[0];
    const amountCurrency = amount === undefined ? undefined : ccyAttribute(amount.attributes);
    if (amountCurrency !== undefined) currencies.push(amountCurrency);
  }
  return currencies;
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
 * Amounts are read in the minor units of `options.currency`, the account's (#671). A file that
 * states another currency, for its statement's account or for any entry's amount, is refused
 * whole, before any entry is read (#672); a file that states none is read in the account's
 * currency.
 *
 * @throws ValidationError "currency_mismatch" (details: fileCurrency, accountCurrency) for a
 * stated currency other than the account's; "invalid_camt053_entry" for an entry missing a
 * required date, amount or credit/debit indicator; "invalid_amount_format"/"invalid_date"/
 * "amount_too_large" for a malformed one.
 */
export function parseCamt053(content: string, options: ImportOptions): ImportRow[] {
  const entries = extractAllBlocks(content, "Ntry");
  for (const currency of statedCurrencies(content, entries)) assertFileCurrency(currency, options.currency);

  return entries.map((entry) => {
    const date = parseCamtDate(entry, "BookgDt") ?? parseCamtDate(entry, "ValDt");
    if (!date) {
      throw new ValidationError("invalid_camt053_entry", "a CAMT.053 entry is missing BookgDt/ValDt", {});
    }
    const cdtDbtInd = extractText(entry, "CdtDbtInd");
    if (cdtDbtInd !== "CRDT" && cdtDbtInd !== "DBIT") {
      throw new ValidationError("invalid_camt053_entry", "a CAMT.053 entry is missing a valid CdtDbtInd", {});
    }
    const magnitude = parseCamtAmount(entry, options.currency);
    // A debit of zero is 0, never -0.
    const amountCents = cdtDbtInd === "DBIT" && magnitude !== 0 ? -magnitude : magnitude;

    const externalId = extractReference(entry, "AcctSvcrRef") ?? extractReference(entry, "NtryRef");

    const ntryDtls = extractBlock(entry, "NtryDtls");
    const txDtls = ntryDtls !== undefined ? extractBlock(ntryDtls, "TxDtls") : undefined;
    const payee = extractCounterpartyName(txDtls, cdtDbtInd === "DBIT");
    const memo = extractRemittanceInfo(txDtls) ?? extractText(entry, "AddtlNtryInf");

    return { date, payee, ...(memo ? { memo } : {}), amountCents, ...(externalId ? { externalId } : {}) };
  });
}
