/**
 * OFX import (design.md, "Import and reconciliation"): self-describing, no
 * column mapping. Each `<STMTTRN>` becomes the same normalized `ImportRow`
 * shape the CSV importer produces (#28), before duplicate detection.
 *
 * OFX 1.x is SGML: most tags are never closed (`<FITID>123`, not
 * `<FITID>123</FITID>`), ending only at the next tag or line break. OFX 2.x
 * is plain XML, always closed. The tag reader below handles both the same
 * way: it stops at the next "<" or line break either way, so it never has to
 * know which version it is reading. `<STMTTRN>` itself, an aggregate (a
 * container of other tags, not a value), is always closed in both versions.
 *
 * Pure, no file I/O: the caller reads the upload and passes its text content here.
 */

import { ValidationError } from "../errors.ts";
import { assertCents, type Cents } from "../money.ts";
import { assertDate, type LocalDate } from "../month.ts";
import type { ImportRow } from "./row.ts";

function extractTag(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<\r\n]*)`, "i").exec(block);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

function parseOfxDate(text: string): LocalDate {
  // "20260915120000[+1:CET]" or "20260915": only the leading YYYYMMDD matters here.
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(text);
  if (!match) {
    throw new ValidationError("invalid_date", `not a valid OFX DTPOSTED: "${text}"`, { value: text });
  }
  const [, year, month, day] = match as unknown as [string, string, string, string];
  const date = `${year}-${month}-${day}`;
  assertDate(date);
  return date;
}

function parseOfxAmount(text: string): Cents {
  const trimmed = text.replace(/^\+/, "");
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new ValidationError("invalid_amount_format", `not a valid OFX TRNAMT: "${text}"`, { text });
  }
  const cents = Math.round(Number(trimmed) * 100);
  assertCents(cents);
  return cents;
}

/**
 * @throws ValidationError for a `<STMTTRN>` missing DTPOSTED or TRNAMT, or a malformed date or amount.
 */
export function parseOfx(content: string): ImportRow[] {
  const blocks = content.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? [];

  return blocks.map((block) => {
    const dtposted = extractTag(block, "DTPOSTED");
    const trnamt = extractTag(block, "TRNAMT");
    if (!dtposted || !trnamt) {
      throw new ValidationError("invalid_ofx_transaction", "a <STMTTRN> is missing DTPOSTED or TRNAMT", {});
    }

    const date = parseOfxDate(dtposted);
    const amountCents = parseOfxAmount(trnamt);
    const payee = extractTag(block, "NAME") ?? extractTag(block, "PAYEE") ?? "";
    const memo = extractTag(block, "MEMO");
    const externalId = extractTag(block, "FITID");

    return { date, payee, ...(memo ? { memo } : {}), amountCents, ...(externalId ? { externalId } : {}) };
  });
}
