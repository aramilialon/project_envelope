/**
 * `pnpm --filter @envelope/api fx-rates:import <file>` (#85): loads a downloaded ECB rates file
 * (`import-fx-rates.ts`) through the server's own connection, `APP_DATABASE_URL` (read from
 * `apps/api/.env` like `start`). A relative path is taken from the directory the command was run
 * in, not from `apps/api`.
 */
import { resolve } from "node:path";

import { isValidationError } from "@envelope/core";

import { createPool } from "../db/pool.ts";
import { importFxRatesFile } from "./import-fx-rates.ts";

async function main(): Promise<void> {
  const [file, ...rest] = process.argv.slice(2);
  if (file === undefined || rest.length > 0) {
    console.error("Usage: pnpm --filter @envelope/api fx-rates:import <file.xml>");
    process.exitCode = 2;
    return;
  }
  const databaseUrl = process.env.APP_DATABASE_URL;
  if (!databaseUrl) {
    console.error("Missing required environment variable: APP_DATABASE_URL (set in apps/api/.env)");
    process.exitCode = 2;
    return;
  }
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
  const pool = createPool(databaseUrl);
  try {
    const result = await importFxRatesFile(pool, path);
    console.log(
      `Exchange rates from ${path}: ${result.inserted} added, ${result.changed.length} changed, ${result.unchanged} already stored.`,
    );
    for (const rate of result.changed) {
      console.log(`  changed: ${rate.quote} on ${rate.date}, ${rate.previousRateE10} → ${rate.rateE10} (× 10^-10)`);
    }
    if (result.skippedCurrencies.length > 0) {
      console.log(`Left out (currencies no longer in use): ${result.skippedCurrencies.join(", ")}.`);
    }
  } catch (error) {
    if (isValidationError(error)) {
      console.error(`The file was refused, nothing was stored: ${error.code} ${JSON.stringify(error.details)} (${error.message})`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
