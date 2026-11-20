import type { InstrumentSearch, InstrumentType, NormalizedInstrument } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";

/**
 * The shared instruments catalog (#76, migration 0026): no workspace and no Row-Level Security,
 * so these queries run on the pool directly. `created_by` is written but never read back: the
 * catalog is shared, and who added an instrument is another workspace's private data.
 */
export interface Instrument {
  readonly id: string;
  readonly isin: string | null;
  readonly ticker: string | null;
  readonly exchange: string | null;
  readonly name: string;
  readonly type: InstrumentType;
  readonly currency: string;
  readonly assetClass: string | null;
  /** amount = quantity × price × priceFactorE6 / 10^6: 1000000, or 10000 for a price in percent of nominal or in pence. */
  readonly priceFactorE6: number;
  readonly createdAt: string;
}

/** Which uniqueness rule a duplicate broke, so the route can answer with a stable 409 `code`. */
export type InstrumentConflict = "isin_taken" | "ticker_taken";

export class InstrumentConflictError extends Error {
  readonly code: InstrumentConflict;

  constructor(code: InstrumentConflict) {
    super(`instrument already in the catalog (${code})`);
    this.name = "InstrumentConflictError";
    this.code = code;
  }
}

/** Most rows a search returns: enough to pick from, never a listing of the catalog. */
export const INSTRUMENT_SEARCH_LIMIT = 20;

const UNIQUE_VIOLATION = "23505";
const CONFLICT_BY_CONSTRAINT: Readonly<Record<string, InstrumentConflict>> = {
  instruments_isin_exchange_key: "isin_taken",
  instruments_ticker_exchange_key: "ticker_taken",
};

const COLUMNS = `id, isin, ticker, exchange, name, type, currency, asset_class, price_factor_e6, created_at`;

interface InstrumentRow {
  id: string;
  isin: string | null;
  ticker: string | null;
  exchange: string | null;
  name: string;
  type: InstrumentType;
  currency: string;
  asset_class: string | null;
  /** node-postgres returns a bigint as a string; always a safe integer here (assertPriceFactorE6 on the way in). */
  price_factor_e6: string;
  created_at: Date;
}

function toInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    isin: row.isin,
    ticker: row.ticker,
    exchange: row.exchange,
    name: row.name,
    type: row.type,
    currency: row.currency,
    assetClass: row.asset_class,
    priceFactorE6: Number(row.price_factor_e6),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Adds an already-normalized instrument (`@envelope/core`'s `normalizeInstrument`) to the catalog.
 *
 * @throws InstrumentConflictError when the same ISIN on the same exchange, or the same ticker on
 *   the same exchange, is already there — decided by the unique indexes, so two concurrent
 *   requests cannot both succeed.
 */
export async function createInstrument(
  db: DbPool | DbClient,
  userId: string,
  instrument: NormalizedInstrument,
): Promise<Instrument> {
  try {
    const { rows } = await db.query<InstrumentRow>(
      `INSERT INTO instruments (isin, ticker, exchange, name, type, currency, asset_class, price_factor_e6, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLUMNS}`,
      [
        instrument.isin,
        instrument.ticker,
        instrument.exchange,
        instrument.name,
        instrument.type,
        instrument.currency,
        instrument.assetClass,
        instrument.priceFactorE6,
        userId,
      ],
    );
    return toInstrument(rows[0]!);
  } catch (error) {
    const conflict = uniqueViolationConflict(error);
    if (conflict) {
      throw new InstrumentConflictError(conflict);
    }
    throw error;
  }
}

function uniqueViolationConflict(error: unknown): InstrumentConflict | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (code !== UNIQUE_VIOLATION || typeof constraint !== "string") return undefined;
  return CONFLICT_BY_CONSTRAINT[constraint];
}

export async function getInstrument(db: DbPool | DbClient, id: string): Promise<Instrument | undefined> {
  const { rows } = await db.query<InstrumentRow>(`SELECT ${COLUMNS} FROM instruments WHERE id = $1`, [id]);
  return rows[0] ? toInstrument(rows[0]) : undefined;
}

/** `LIKE`'s own wildcards, escaped so a typed `%` or `_` matches itself. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * At most `INSTRUMENT_SEARCH_LIMIT` instruments: every listing of an exact ISIN, or those whose
 * ticker or name starts with the prefix (ignoring case), exact ticker matches first, then by name.
 * The search itself comes from `@envelope/core`'s `parseInstrumentSearch`, which refuses a query
 * short enough to list the whole catalog.
 */
export async function searchInstruments(db: DbPool | DbClient, search: InstrumentSearch): Promise<Instrument[]> {
  if (search.kind === "isin") {
    const { rows } = await db.query<InstrumentRow>(
      `SELECT ${COLUMNS} FROM instruments WHERE isin = $1 ORDER BY exchange NULLS FIRST, name, id LIMIT $2`,
      [search.isin, INSTRUMENT_SEARCH_LIMIT],
    );
    return rows.map(toInstrument);
  }
  const { rows } = await db.query<InstrumentRow>(
    `SELECT ${COLUMNS} FROM instruments
     WHERE upper(ticker) LIKE $1 OR lower(name) LIKE $2
     ORDER BY (upper(ticker) = $3) IS NOT TRUE, name, exchange NULLS FIRST, id
     LIMIT $4`,
    [
      `${escapeLike(search.prefix.toUpperCase())}%`,
      `${escapeLike(search.prefix.toLowerCase())}%`,
      search.prefix.toUpperCase(),
      INSTRUMENT_SEARCH_LIMIT,
    ],
  );
  return rows.map(toInstrument);
}
