/**
 * Historical closing prices (#82, migration 0034, ADR 0019).
 *
 * A request reads the shared prices and its own workspace's, and writes only its own workspace's;
 * the table's Row-Level Security enforces both, and every query here names the workspace as well.
 * Which price values an instrument on a date is @envelope/core's resolvePrice: this module only
 * loads the candidates, own and shared alike, and never applies the precedence itself.
 */
import {
  assertDate,
  assertPrice,
  ValidationError,
  type LocalDate,
  type Price,
  type PriceCandidate,
  type PriceOrigin,
} from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";

/** How a workspace's own price was entered. A provider's price is shared and is written only by a system job. */
export type WorkspacePriceSource = "manual" | "csv";

export type PriceSource = WorkspacePriceSource | "provider";

export interface PriceInput {
  readonly priceDate: LocalDate;
  readonly closeE6: number;
}

export interface UpsertPricesResult {
  /** Dates that had no price of the workspace's own. */
  readonly inserted: number;
  /** Dates whose own price had another close, now replaced. */
  readonly replaced: number;
  /** Dates whose own price already had this close: left as they were, source included. */
  readonly unchanged: number;
}

export interface PriceRecord {
  readonly priceDate: LocalDate;
  readonly closeE6: Price;
  readonly source: PriceSource;
  readonly origin: PriceOrigin;
}

interface PriceRow {
  readonly instrument_id: string;
  readonly price_date: string;
  readonly close_e6: string;
  readonly source: PriceSource;
  readonly origin: PriceOrigin;
}

/** Every column the readers below select, a date as `YYYY-MM-DD` and the row's origin. */
const PRICE_COLUMNS = `instrument_id, to_char(price_date, 'YYYY-MM-DD') AS price_date, close_e6, source,
  CASE WHEN workspace_id IS NULL THEN 'shared' ELSE 'own' END AS origin`;

/** A `bigint` close as an exact price; the CHECK keeps every value within the safe-integer range. */
function toClose(value: string): Price {
  const close = Number(value);
  assertPrice(close, "close_e6");
  return close;
}

/**
 * Writes a workspace's own closing prices of one instrument, one per date: a date with no own price
 * is inserted, one with another close is replaced (its source becomes `source`), one with the same
 * close is left alone. The shared price of the same date is never touched.
 *
 * Runs as one statement, so it must run inside the request's transaction with `app.workspace_id`
 * set to `workspaceId`; the table's policies refuse any other workspace. An instrument the caller
 * cannot see is refused by migration 0034's trigger (a check_violation naming `instrument_not_found`).
 *
 * @throws ValidationError `invalid_date` or `invalid_price` for a malformed row, `duplicate_price`
 *   for a date given twice.
 */
export async function upsertWorkspacePrices(
  db: DbPool | DbClient,
  workspaceId: string,
  instrumentId: string,
  rows: readonly PriceInput[],
  source: WorkspacePriceSource,
  createdBy: string | null = null,
): Promise<UpsertPricesResult> {
  const seen = new Set<string>();
  for (const row of rows) {
    assertDate(row.priceDate);
    assertPrice(row.closeE6, "closeE6");
    if (seen.has(row.priceDate)) {
      throw new ValidationError("duplicate_price", `the date ${row.priceDate} is given twice`, {
        date: row.priceDate,
        origin: "own",
      });
    }
    seen.add(row.priceDate);
  }
  if (rows.length === 0) {
    return { inserted: 0, replaced: 0, unchanged: 0 };
  }

  // xmax is 0 on a row this statement inserted, and set on one it updated. A row whose close did
  // not change is not updated (the WHERE below) and so not returned at all.
  const { rows: written } = await db.query<{ inserted: boolean }>(
    `INSERT INTO prices (workspace_id, instrument_id, price_date, close_e6, source, created_by)
     SELECT $1, $2, input.price_date, input.close_e6, $5, $6
     FROM unnest($3::date[], $4::bigint[]) AS input (price_date, close_e6)
     ON CONFLICT (workspace_id, instrument_id, price_date) DO UPDATE
       SET close_e6 = EXCLUDED.close_e6, source = EXCLUDED.source, updated_at = now()
       WHERE prices.close_e6 IS DISTINCT FROM EXCLUDED.close_e6
     RETURNING (xmax = 0) AS inserted`,
    [
      workspaceId,
      instrumentId,
      rows.map((row) => row.priceDate),
      rows.map((row) => String(row.closeE6)),
      source,
      createdBy,
    ],
  );
  const inserted = written.filter((row) => row.inserted).length;
  const replaced = written.length - inserted;
  return { inserted, replaced, unchanged: rows.length - written.length };
}

/** Deletes the workspace's own price of an instrument on a date; `false` when it has none. Never a shared price. */
export async function deleteWorkspacePrice(
  db: DbPool | DbClient,
  workspaceId: string,
  instrumentId: string,
  priceDate: LocalDate,
): Promise<boolean> {
  assertDate(priceDate);
  const { rowCount } = await db.query(
    "DELETE FROM prices WHERE workspace_id = $1 AND instrument_id = $2 AND price_date = $3",
    [workspaceId, instrumentId, priceDate],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The prices of an instrument from `from` to `to`, both included, own and shared alike, each tagged
 * with its origin: by date, and on the same date the shared one first.
 */
export async function listPrices(
  db: DbPool | DbClient,
  workspaceId: string,
  instrumentId: string,
  from: LocalDate,
  to: LocalDate,
): Promise<PriceRecord[]> {
  assertDate(from);
  assertDate(to);
  const { rows } = await db.query<PriceRow>(
    `SELECT ${PRICE_COLUMNS} FROM prices
     WHERE (workspace_id IS NULL OR workspace_id = $1) AND instrument_id = $2 AND price_date BETWEEN $3 AND $4
     ORDER BY price_date, workspace_id NULLS FIRST`,
    [workspaceId, instrumentId, from, to],
  );
  return rows.map((row) => ({ priceDate: row.price_date, closeE6: toClose(row.close_e6), source: row.source, origin: row.origin }));
}

/**
 * Every price of each instrument dated on or before `upTo`, own and shared alike, as the
 * candidates @envelope/core's resolvePrice and priceSeriesAt choose from. Every instrument asked for
 * has an entry, empty when it has no price.
 */
export async function loadPriceCandidates(
  db: DbPool | DbClient,
  workspaceId: string,
  instrumentIds: readonly string[],
  upTo: LocalDate,
): Promise<Map<string, PriceCandidate[]>> {
  assertDate(upTo);
  const candidates = new Map<string, PriceCandidate[]>(instrumentIds.map((id) => [id, []]));
  if (instrumentIds.length === 0) {
    return candidates;
  }
  const { rows } = await db.query<PriceRow>(
    `SELECT ${PRICE_COLUMNS} FROM prices
     WHERE (workspace_id IS NULL OR workspace_id = $1) AND instrument_id = ANY($2::uuid[]) AND price_date <= $3
     ORDER BY instrument_id, price_date`,
    [workspaceId, [...new Set(instrumentIds)], upTo],
  );
  for (const row of rows) {
    candidates.get(row.instrument_id)?.push({ priceDate: row.price_date, closeE6: toClose(row.close_e6), origin: row.origin });
  }
  return candidates;
}
