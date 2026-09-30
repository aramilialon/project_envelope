import { buildApp } from "./app.ts";
import { loadConfig, loadQueueConfig } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { createQueueDriver } from "./queue/index.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  // A pool of its own, separate from buildApp's (both envelope_app, both config.databaseUrl):
  // a job's own effects run through this one (#36), independent of any particular request.
  const queuePool = createPool(config.databaseUrl);
  const queue = createQueueDriver(loadQueueConfig(), queuePool);
  await queue.start();

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
