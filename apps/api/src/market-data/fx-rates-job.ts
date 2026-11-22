/**
 * The `fx-rates-fetch` job (#85, ADR 0019): brings the stored euro reference rates up to date
 * from a provider (the ECB adapter), through the queue module like every background job, so a
 * request never waits on, or calls, an outside source.
 *
 * - Scheduled at 15:30 and 21:30 UTC on working days (`FX_RATES_FETCH_CRON`): the ECB publishes
 *   around 16:00 Central European Time (15:00 UTC in winter, 14:00 in summer); the second run
 *   catches a late publication or a failed first run.
 * - Enqueued once at startup too, deduplicated by the UTC day (`fx-rates:ecb:<date>`), so a new
 *   server has rates within a minute rather than at the next scheduled run.
 * - `MARKET_DATA_FETCH_ENABLED=false` turns all of it off: nothing scheduled or enqueued, and a
 *   delivery still pending (or a schedule left from an earlier start with fetching on) returns
 *   without fetching. The administration command (`import-fx-rates.ts`) loads a downloaded file
 *   instead.
 *
 * The handler reads the newest stored day (no flag needed: every caller reads rates), asks the
 * provider for what follows it within `timeoutMs`, then writes through `writeFxRates`, which
 * sets the system-job flag (app.is_system_job) for its own statements only. A repeat delivery of the same job id is
 * discarded by the queue module before the handler runs (`processed_jobs`); a second job on the
 * same day finds the same rows and changes nothing.
 */
import type { DbClient } from "../db/pool.ts";
import type { JobHandler } from "../queue/driver.ts";
import type { QueueDriver } from "../queue/index.ts";
import { FX_RATES_FETCH_JOB, type FxRatesFetchJobData } from "../queue/job-types.ts";
import { latestFxRateDate, writeFxRates } from "./fx-rates-repository.ts";
import type { MarketDataProvider } from "./provider.ts";

/** Minute 30 of 15:00 and 21:00 UTC, Monday to Friday (the queue's cron runs in UTC). */
export const FX_RATES_FETCH_CRON = "30 15,21 * * 1-5";

/** How long one fetch may take, the body included: the full history is about 8 MB. */
export const FX_RATES_FETCH_TIMEOUT_MS = 60_000;

/** How many changed rates one log line lists; the rest are only counted. */
const CHANGED_RATES_LOGGED = 20;

/** The part of a pino logger the job uses. */
export interface JobLogger {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
}

export interface FxRatesFetchOptions {
  readonly enabled: boolean;
  readonly provider: MarketDataProvider;
  readonly log: JobLogger;
  readonly timeoutMs?: number;
}

export function createFxRatesFetchHandler(options: FxRatesFetchOptions): JobHandler<FxRatesFetchJobData> {
  const timeoutMs = options.timeoutMs ?? FX_RATES_FETCH_TIMEOUT_MS;
  return async (_data: FxRatesFetchJobData, db: DbClient) => {
    const { provider, log } = options;
    if (!options.enabled || provider.fetchFxRates === undefined) {
      log.info({}, "exchange rates not fetched: fetching is off");
      return;
    }
    const since = await latestFxRateDate(db);
    const rates = await provider.fetchFxRates({ since }, AbortSignal.timeout(timeoutMs));
    const result = await writeFxRates(db, rates, provider.id);
    if (result.changed.length > 0) {
      log.warn(
        { count: result.changed.length, changed: result.changed.slice(0, CHANGED_RATES_LOGGED) },
        "stored exchange rates changed: the source published other values for days already stored",
      );
    }
    log.info(
      { provider: provider.id, since, inserted: result.inserted, changed: result.changed.length, unchanged: result.unchanged },
      "exchange rates stored",
    );
  };
}

/** The deduplication key of the startup run: one per UTC day. */
export function fxRatesStartupKey(now: Date): string {
  return `fx-rates:ecb:${now.toISOString().slice(0, 10)}`;
}

/**
 * Registers the job's handler, and, when fetching is on, its schedule and one run now. With
 * fetching off, the handler is still registered, so a delivery left from an earlier start is
 * answered (without fetching) rather than retried forever, and one log line says rates are not
 * fetched.
 */
export async function registerFxRatesJob(queue: QueueDriver, options: FxRatesFetchOptions, now: Date = new Date()): Promise<void> {
  await queue.work(FX_RATES_FETCH_JOB, createFxRatesFetchHandler(options));
  if (!options.enabled) {
    options.log.info({}, "MARKET_DATA_FETCH_ENABLED is false: exchange rates are not fetched; load a file with fx-rates:import");
    return;
  }
  await queue.schedule(FX_RATES_FETCH_JOB, FX_RATES_FETCH_CRON);
  await queue.enqueue(FX_RATES_FETCH_JOB, {}, { deduplicationKey: fxRatesStartupKey(now) });
}
