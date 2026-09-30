import type { Cents } from "../money.ts";
import type { LocalDate } from "../month.ts";

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
