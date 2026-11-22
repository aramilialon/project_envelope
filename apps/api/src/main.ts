import { buildApp } from "./app.ts";
import { loadConfig, loadMarketDataConfig, loadPushConfig, loadQueueConfig } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { createEcbFileFetcher, createEcbProvider } from "./market-data/ecb-provider.ts";
import { registerFxRatesJob } from "./market-data/fx-rates-job.ts";
import { createPriceProvider } from "./market-data/registry.ts";
import { createBudgetRecomputeHandler } from "./notifications/budget-recompute-job.ts";
import { createPushDrivers } from "./notifications/index.ts";
import { createQueueDriver } from "./queue/index.ts";
import { BUDGET_RECOMPUTE_JOB, FX_RATES_FETCH_JOB, SCHEDULED_TRANSACTIONS_FIRE_JOB } from "./queue/job-types.ts";
import { createScheduledTransactionsFireHandler } from "./scheduled-transactions/fire-job.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  // Market data (#84, #85, ADR 0019), checked before anything starts: an unknown
  // MARKET_DATA_PRICE_PROVIDER or a bad MARKET_DATA_ECB_URL stops the server here. Nothing reads
  // the price provider yet (no provider job before one that fetches prices is added).
  const marketData = loadMarketDataConfig();
  createPriceProvider(marketData.priceProvider);
  // A pool of its own, separate from buildApp's (both envelope_app, both config.databaseUrl):
  // a job's own effects run through this one (#36), independent of any particular request.
  const queuePool = createPool(config.databaseUrl);
  const queue = createQueueDriver(loadQueueConfig(), queuePool);
  await queue.start();
  const pushConfig = loadPushConfig();
  const pushDrivers = createPushDrivers(pushConfig);
  await queue.work(BUDGET_RECOMPUTE_JOB, createBudgetRecomputeHandler(pushDrivers));
  // Hourly: frequent enough that every workspace's own local midnight (whatever its time zone)
  // is caught within the hour, without polling far more often than a day-granularity due date
  // ever needs (#38).
  await queue.schedule(SCHEDULED_TRANSACTIONS_FIRE_JOB, "0 * * * *");
  await queue.work(SCHEDULED_TRANSACTIONS_FIRE_JOB, createScheduledTransactionsFireHandler(queue));

  const app = buildApp(config, queue, pushConfig.vapidPublicKey);

  // The exchange rates job fetches only when MARKET_DATA_FETCH_ENABLED is on, its default.
  await registerFxRatesJob(queue, {
    enabled: marketData.fetchEnabled,
    provider: createEcbProvider({ fetchFile: createEcbFileFetcher({ baseUrl: marketData.ecbBaseUrl }) }),
    log: app.fastify.log.child({ job: FX_RATES_FETCH_JOB }),
  });

  await app.fastify.listen({ host: config.host, port: config.port });
  // One machine-readable line with the address actually bound, whatever LOG_LEVEL says: with
  // PORT=0 (the smoke tests, #519) nothing else tells a caller which port the system picked.
  const address = app.fastify.server.address();
  if (address !== null && typeof address === "object") {
    process.stdout.write(`${JSON.stringify({ msg: "listening", address: address.address, port: address.port })}\n`);
  }

  const shutdown = (): void => {
    Promise.all([app.close(), queue.stop(), queuePool.end()]).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
