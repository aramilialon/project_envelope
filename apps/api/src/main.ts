import { buildApp } from "./app.ts";
import { loadConfig, loadPushConfig, loadQueueConfig } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { createBudgetRecomputeHandler } from "./notifications/budget-recompute-job.ts";
import { createPushDrivers } from "./notifications/index.ts";
import { createQueueDriver } from "./queue/index.ts";
import { BUDGET_RECOMPUTE_JOB, SCHEDULED_TRANSACTIONS_FIRE_JOB } from "./queue/job-types.ts";
import { createScheduledTransactionsFireHandler } from "./scheduled-transactions/fire-job.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  // A pool of its own, separate from buildApp's (both envelope_app, both config.databaseUrl):
  // a job's own effects run through this one (#36), independent of any particular request.
  const queuePool = createPool(config.databaseUrl);
  const queue = createQueueDriver(loadQueueConfig(), queuePool);
  await queue.start();
  const pushDrivers = createPushDrivers(loadPushConfig());
  await queue.work(BUDGET_RECOMPUTE_JOB, createBudgetRecomputeHandler(pushDrivers));
  // Hourly: frequent enough that every workspace's own local midnight (whatever its time zone)
  // is caught within the hour, without polling far more often than a day-granularity due date
  // ever needs (#38).
  await queue.schedule(SCHEDULED_TRANSACTIONS_FIRE_JOB, "0 * * * *");
  await queue.work(SCHEDULED_TRANSACTIONS_FIRE_JOB, createScheduledTransactionsFireHandler(queue));

  const app = buildApp(config, queue);

  await app.fastify.listen({ host: config.host, port: config.port });

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
