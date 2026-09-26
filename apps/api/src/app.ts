import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { createAuthPreHandler, createTokenVerifier } from "./auth/token-verifier.ts";
import { createUserMapperPreHandler } from "./auth/user-mapper.ts";
import type { Config } from "./config.ts";
import { createPool, type DbPool } from "./db/pool.ts";
import { registerHealthRoute } from "./routes/health.ts";

/**
 * Routes that stay reachable without a token: just the health check, which
 * orchestrators and load balancers must be able to call unauthenticated.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/health"]);

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

  const verifier = createTokenVerifier(config);
  const authPreHandler = createAuthPreHandler(verifier);
  const userMapperPreHandler = createUserMapperPreHandler(pool);

  // Registered once, globally, so a new route rejects a missing or foreign
  // token by default instead of a developer having to remember to add these
  // preHandlers to it (#10). Route-specific concerns, such as workspace
  // membership, still opt in per route: unlike auth, not every route names a
  // workspace.
  fastify.addHook("preHandler", skipPublicPaths(authPreHandler));
  fastify.addHook("preHandler", skipPublicPaths(userMapperPreHandler));

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

function skipPublicPaths(
  preHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const path = request.url.split("?")[0];
    if (path !== undefined && PUBLIC_PATHS.has(path)) {
      return;
    }
    await preHandler(request, reply);
  };
}
