/**
 * Exchange rates (`fx_rates`, migration 0036, ADR 0019): reading them, and writing them as a
 * system job.
 *
 * Every caller reads every rate. Only `writeFxRates` writes, and it is the one place in this
 * module that sets `app.is_system_job`: for its own statements only, and back off before it
 * returns, so whatever its caller does next in the same transaction runs without it
 * (`src/db/system-job-allowlist.test.ts` lists every file allowed to set the flag).
 */
import { FX_BASE_CURRENCY, type FxRate, fxRateTable, type LocalDate } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";

/** Rows per statement: keeps each one's parameters and memory small when the full history (about 200 000 rows) is written. */
const WRITE_BATCH_SIZE = 10_000;

/** A stored rate that a newer file gave another value for. */
export interface ChangedFxRate {
  readonly quote: string;
  readonly date: LocalDate;
  readonly previousRateE10: number;
  readonly rateE10: number;
}

export interface FxRatesWriteResult {
  readonly inserted: number;
  readonly changed: readonly ChangedFxRate[];
  readonly unchanged: number;
}

/** The newest day any rate is stored for, or null when there is none. */
export async function latestFxRateDate(db: DbClient | DbPool): Promise<LocalDate | null> {
  const { rows } = await db.query<{ latest: string | null }>("SELECT to_char(max(rate_date), 'YYYY-MM-DD') AS latest FROM fx_rates");
  return rows[0]?.latest ?? null;
}

/**
 * Stores rates as shared rows: a new currency and day is inserted, a stored one whose value
 * differs is updated (and returned in `changed`, for the caller to log), an equal one is left
 * untouched, `fetched_at` included. Writing the same file twice changes nothing.
 *
 * `db` must be inside a transaction: the flag set here is local to it (`set_config(…, true)`),
 * and is reset before this returns. On an error the caller rolls back, which resets it too.
 *
 * @throws ValidationError "invalid_fx_rate" (from `fxRateTable`) for a rate that is not quoted
 *   against the euro, a bad currency or date, a value outside 1 to 2^53 − 1, or a currency given
 *   twice for one day, before anything is written.
 */
export async function writeFxRates(db: DbClient, rates: readonly FxRate[], source: string): Promise<FxRatesWriteResult> {
  fxRateTable(rates);
  let inserted = 0;
  const changed: ChangedFxRate[] = [];
  await db.query("SELECT set_config('app.is_system_job', 'true', true)");
  for (let start = 0; start < rates.length; start += WRITE_BATCH_SIZE) {
    const batch = rates.slice(start, start + WRITE_BATCH_SIZE);
    const { rows } = await db.query<{ inserted: number; changed: ChangedFxRate[] }>(
      `WITH incoming AS (
         SELECT * FROM unnest($1::text[], $2::date[], $3::bigint[]) AS i (quote_currency, rate_date, rate_e10)
       ),
       previous AS (
         SELECT f.quote_currency, f.rate_date, f.rate_e10
         FROM fx_rates f
         JOIN incoming i USING (quote_currency, rate_date)
         WHERE f.base_currency = $4
       ),
       written AS (
         INSERT INTO fx_rates (base_currency, quote_currency, rate_date, rate_e10, source)
         SELECT $4, quote_currency, rate_date, rate_e10, $5 FROM incoming
         ON CONFLICT (base_currency, quote_currency, rate_date) DO UPDATE
           SET rate_e10 = EXCLUDED.rate_e10, source = EXCLUDED.source, fetched_at = now()
           WHERE fx_rates.rate_e10 IS DISTINCT FROM EXCLUDED.rate_e10
         RETURNING quote_currency, rate_date, rate_e10
       )
       SELECT
         (count(*) FILTER (WHERE p.rate_e10 IS NULL))::int AS inserted,
         coalesce(
           json_agg(
             json_build_object(
               'quote', w.quote_currency,
               'date', to_char(w.rate_date, 'YYYY-MM-DD'),
               'previousRateE10', p.rate_e10,
               'rateE10', w.rate_e10
             ) ORDER BY w.rate_date, w.quote_currency
           ) FILTER (WHERE p.rate_e10 IS NOT NULL),
           '[]'
         ) AS changed
       FROM written w
       LEFT JOIN previous p USING (quote_currency, rate_date)`,
      [batch.map((r) => r.quote), batch.map((r) => r.date), batch.map((r) => r.rateE10), FX_BASE_CURRENCY, source],
    );
    inserted += rows[0]?.inserted ?? 0;
    changed.push(...(rows[0]?.changed ?? []));
  }
  await db.query("SELECT set_config('app.is_system_job', '', true)");
  return { inserted, changed, unchanged: rates.length - inserted - changed.length };
}

/** One stored rate, as the API returns it. */
export interface StoredFxRate {
  readonly date: LocalDate;
  readonly rateE10: number;
}

/** The rates of one currency, oldest first, from and to the given days when given (both included). */
export async function listFxRates(
  db: DbClient | DbPool,
  quote: string,
  from: LocalDate | null,
  to: LocalDate | null,
): Promise<StoredFxRate[]> {
  const { rows } = await db.query<{ date: string; rate_e10: string }>(
    `SELECT to_char(rate_date, 'YYYY-MM-DD') AS date, rate_e10
     FROM fx_rates
     WHERE base_currency = $1 AND quote_currency = $2
       AND ($3::date IS NULL OR rate_date >= $3::date)
       AND ($4::date IS NULL OR rate_date <= $4::date)
     ORDER BY rate_date`,
    [FX_BASE_CURRENCY, quote, from, to],
  );
  return rows.map((row) => ({ date: row.date, rateE10: Number(row.rate_e10) }));
}

/**
 * Every stored rate of the given currencies dated on or before `upTo`, as `@envelope/core`'s
 * conversions take them (`fxRateTable`): a conversion uses the latest one on or before its date,
 * however old, so nothing earlier is left out. The euro, which needs no rate, is skipped.
 */
export async function loadFxRates(db: DbClient | DbPool, currencies: readonly string[], upTo: LocalDate): Promise<FxRate[]> {
  const quotes = [...new Set(currencies)].filter((currency) => currency !== FX_BASE_CURRENCY);
  if (quotes.length === 0) {
    return [];
  }
  const { rows } = await db.query<{ quote: string; date: string; rate_e10: string }>(
    `SELECT quote_currency AS quote, to_char(rate_date, 'YYYY-MM-DD') AS date, rate_e10
     FROM fx_rates
     WHERE base_currency = $1 AND quote_currency = ANY($2::text[]) AND rate_date <= $3::date
     ORDER BY quote_currency, rate_date`,
    [FX_BASE_CURRENCY, quotes, upTo],
  );
  return rows.map((row) => ({ base: FX_BASE_CURRENCY, quote: row.quote, date: row.date, rateE10: Number(row.rate_e10) }));
}
