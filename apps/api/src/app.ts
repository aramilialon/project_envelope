import Fastify, { type FastifyInstance } from "fastify";

import type { Config } from "./config.ts";
import { createPool, type DbPool } from "./db/pool.ts";
import { registerHealthRoute } from "./routes/health.ts";

export interface App {
  readonly fastify: FastifyInstance;
  readonly pool: DbPool;
  close(): Promise<void>;
}

export function buildApp(config: Config): App {
  const loggerOptions = config.logPretty
    ? { level: config.logLevel, transport: { target: "pino-pretty" } }
    : { level: config.logLevel };

  const fastify = Fastify({ logger: loggerOptions });
  const pool = createPool(config.databaseUrl);

  registerHealthRoute(fastify, pool);

  return {
    fastify,
    pool,
    async close(): Promise<void> {
      await fastify.close();
      await pool.end();
    },
  };
}
