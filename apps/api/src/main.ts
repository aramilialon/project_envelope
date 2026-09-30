import { buildApp } from "./app.ts";
import { loadConfig, loadQueueConfig } from "./config.ts";
import { createQueueDriver } from "./queue/index.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const queue = createQueueDriver(loadQueueConfig());
  await queue.start();

  const app = buildApp(config, queue);

  await app.fastify.listen({ host: config.host, port: config.port });

  const shutdown = (): void => {
    Promise.all([app.close(), queue.stop()]).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
