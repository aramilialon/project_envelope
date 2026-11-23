import type { Cents, CurrencyCode } from "../money.ts";
import type { LocalDate } from "../month.ts";

/**
 * What every import parser needs to know about the account the file goes
 * into: its currency, so amounts are read in its minor units (#671) and a
 * file stating another currency is refused (#672).
 */
export interface ImportOptions {
  readonly currency: CurrencyCode;
}

/**
 * A normalized row from any import source, before duplicate detection
 * (`detectDuplicates`, #27): CSV, OFX (#29), and later QIF and CAMT.053 all
 * produce this same shape.
 */
export interface ImportRow {
  readonly date: LocalDate;
  readonly payee: string;
  readonly memo?: string;
  readonly amountCents: Cents;
  /** The source format's own transaction id, when it carries one (OFX's FITID) — matched first in duplicate detection. */
  readonly externalId?: string;
}
