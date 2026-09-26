import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp(config);

  await app.fastify.listen({ host: config.host, port: config.port });

  const shutdown = (): void => {
    app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
