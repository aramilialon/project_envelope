/**
 * Loading exchange rates from a downloaded ECB file (#85): the way to get rates with
 * `MARKET_DATA_FETCH_ENABLED=false`, or on a machine that cannot reach the ECB. The administrator
 * downloads the daily, 90-day or full history XML file elsewhere and runs
 * `pnpm --filter @envelope/api fx-rates:import <file>` (`import-fx-rates-command.ts`).
 *
 * The file goes through the same parser and the same write as a fetched one: refused as a whole
 * when anything in it is malformed, and written in one transaction, so a refused file leaves the
 * stored rates as they were.
 */
import { stat, readFile } from "node:fs/promises";

import { ECB_RATES_FILE_MAX_CHARS, parseEcbReferenceRates, ValidationError } from "@envelope/core";

import type { DbPool } from "../db/pool.ts";
import { ECB_PROVIDER_ID } from "./ecb-provider.ts";
import { type FxRatesWriteResult, writeFxRates } from "./fx-rates-repository.ts";

export interface FxRatesImportResult extends FxRatesWriteResult {
  readonly skippedCurrencies: readonly string[];
}

/**
 * @throws ValidationError "invalid_rates_file" (from `parseEcbReferenceRates`, or `too_large`
 *   before the file is read), and nothing is written.
 */
export async function importFxRatesFile(pool: DbPool, path: string): Promise<FxRatesImportResult> {
  const { size } = await stat(path);
  if (size > ECB_RATES_FILE_MAX_CHARS) {
    throw new ValidationError("invalid_rates_file", `the file is larger than ${ECB_RATES_FILE_MAX_CHARS} bytes`, {
      reason: "too_large",
      max: ECB_RATES_FILE_MAX_CHARS,
    });
  }
  const { rates, skippedCurrencies } = parseEcbReferenceRates(await readFile(path, "utf8"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await writeFxRates(client, rates, ECB_PROVIDER_ID);
    await client.query("COMMIT");
    return { ...result, skippedCurrencies };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
