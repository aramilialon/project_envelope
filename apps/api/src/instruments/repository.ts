import { toPriceFactor, type InstrumentSearch, type InstrumentType, type NormalizedInstrument, type PriceFactor } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";

/**
 * Instruments (#76, migration 0026): the shared catalog, and since #505 (migration 0035) each
 * workspace's private instruments. Row-Level Security decides which rows a query sees: the shared
 * ones always, a workspace's own only on a connection whose request selected that workspace
 * (`request.db`). The /instruments routes run on the pool with no workspace, so they see the
 * shared catalog only. Neither `created_by` nor `created_at` is ever read back: who added a shared
 * instrument, or when, is another workspace's private data.
 */
export interface Instrument {
  readonly id: string;
  /** The workspace a private instrument belongs to; `null` for the shared catalog. */
  readonly workspaceId: string | null;
  readonly isin: string | null;
  readonly ticker: string | null;
  readonly exchange: string | null;
  readonly name: string;
  readonly type: InstrumentType;
  readonly currency: string;
  readonly assetClass: string | null;
  /** The price factor × 10^6 ([ADR 0011](../../../../docs/adr/0011-quantities-and-prices-as-scaled-integers.md)): 1000000, or 10000 for a price in percent of nominal or in pence. */
  readonly priceFactorE6: PriceFactor;
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

/**
 * Most rows a search returns: enough to pick from. For usability, not confidentiality: any
 * signed-in user can still read the whole catalog by trying every prefix.
 */
export const INSTRUMENT_SEARCH_LIMIT = 20;

const UNIQUE_VIOLATION = "23505";
const CONFLICT_BY_CONSTRAINT: Readonly<Record<string, InstrumentConflict>> = {
  instruments_isin_exchange_key: "isin_taken",
  instruments_ticker_exchange_key: "ticker_taken",
};

const COLUMNS = `id, workspace_id, isin, ticker, exchange, name, type, currency, asset_class, price_factor_e6`;

interface InstrumentRow {
  id: string;
  workspace_id: string | null;
  isin: string | null;
  ticker: string | null;
  exchange: string | null;
  name: string;
  type: InstrumentType;
  currency: string;
  asset_class: string | null;
  /** node-postgres returns a bigint as a string; `toPriceFactor` checks it is a positive safe integer. */
  price_factor_e6: string;
}

function toInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    isin: row.isin,
    ticker: row.ticker,
    exchange: row.exchange,
    name: row.name,
    type: row.type,
    currency: row.currency,
    assetClass: row.asset_class,
    priceFactorE6: toPriceFactor(Number(row.price_factor_e6), "price_factor_e6"),
  };
}

/**
 * Adds an already-normalized instrument to the shared catalog (`@envelope/core`'s
 * `normalizeInstrument`, `workspaceId` null) or to a workspace's own instruments
 * (`normalizePrivateInstrument`, on the request's connection: Row-Level Security refuses another
 * workspace's id).
 *
 * @throws InstrumentConflictError when the same ISIN on the same exchange, or the same ticker on
 *   the same exchange, is already there — decided by the unique indexes, so two concurrent
 *   requests cannot both succeed.
 */
export async function createInstrument(
  db: DbPool | DbClient,
  userId: string,
  instrument: NormalizedInstrument,
  workspaceId: string | null = null,
): Promise<Instrument> {
  try {
    const { rows } = await db.query<InstrumentRow>(
      `INSERT INTO instruments (isin, ticker, exchange, name, type, currency, asset_class, price_factor_e6, created_by, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
        workspaceId,
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

/** The instruments with these ids, by id; an unknown id is left out. */
export async function getInstruments(db: DbPool | DbClient, ids: readonly string[]): Promise<Map<string, Instrument>> {
  if (ids.length === 0) {
    return new Map();
  }
  const { rows } = await db.query<InstrumentRow>(`SELECT ${COLUMNS} FROM instruments WHERE id = ANY($1)`, [ids]);
  return new Map(rows.map((row) => [row.id, toInstrument(row)]));
}

/**
 * A workspace's own private instruments, by name (ignoring case), then id. Filtered on the
 * workspace as well as by Row-Level Security, so the shared catalog never shows up here.
 */
export async function listWorkspaceInstruments(db: DbClient, workspaceId: string): Promise<Instrument[]> {
  const { rows } = await db.query<InstrumentRow>(
    `SELECT ${COLUMNS} FROM instruments WHERE workspace_id = $1 ORDER BY lower(name), id`,
    [workspaceId],
  );
  return rows.map(toInstrument);
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
