import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { createAuthPreHandler, createTokenVerifier } from "./auth/token-verifier.ts";
import { createUserMapperPreHandler } from "./auth/user-mapper.ts";
import { registerWorkspaceScope } from "./auth/workspace-membership.ts";
import type { Config } from "./config.ts";
import { createPool, type DbPool } from "./db/pool.ts";
import type { QueueDriver } from "./queue/index.ts";
import { registerAccountsRoutes } from "./routes/accounts.ts";
import { registerAssignmentsRoutes } from "./routes/assignments.ts";
import { registerBudgetRoutes } from "./routes/budget.ts";
import { registerCategoriesRoutes } from "./routes/categories.ts";
import { registerDaysOfBufferRoutes } from "./routes/days-of-buffer.ts";
import { registerGoalsRoutes } from "./routes/goals.ts";
import { registerHealthRoute } from "./routes/health.ts";
import { registerImportRoutes } from "./routes/import.ts";
import { registerMeRoute } from "./routes/me.ts";
import { registerMyWorkspacesRoute } from "./routes/my-workspaces.ts";
import { registerQuickAssignRoutes } from "./routes/quick-assign.ts";
import { registerReconciliationRoutes } from "./routes/reconciliation.ts";
import { registerScheduledTransactionsRoutes } from "./routes/scheduled-transactions.ts";
import { registerSyncRoutes } from "./routes/sync.ts";
import { registerTransactionsRoutes } from "./routes/transactions.ts";

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

/**
 * `queue`, when given, lets a write path enqueue a job in the same transaction as the data
 * that triggers it (#35). Omitted, routes work exactly as before: no queue, no job enqueued —
 * every existing test that builds an app without one keeps working unchanged.
 */
export function buildApp(config: Config, queue?: QueueDriver): App {
  const loggerOptions = config.logPretty
    ? { level: config.logLevel, transport: { target: "pino-pretty" } }
    : { level: config.logLevel };

  const fastify = Fastify({ logger: loggerOptions });
  const pool = createPool(config.databaseUrl);

  // The web app (#48) calls this API from its own origin; nothing else needs to.
  void fastify.register(cors, { origin: config.webOrigin });

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

  registerWorkspaceScope(fastify);
  registerHealthRoute(fastify, pool);
  registerAccountsRoutes(fastify, pool);
  registerAssignmentsRoutes(fastify, pool);
  registerBudgetRoutes(fastify, pool);
  registerCategoriesRoutes(fastify, pool);
  registerDaysOfBufferRoutes(fastify, pool);
  registerGoalsRoutes(fastify, pool);
  registerImportRoutes(fastify, pool);
  registerMyWorkspacesRoute(fastify, pool);
  registerQuickAssignRoutes(fastify, pool);
  registerReconciliationRoutes(fastify, pool);
  registerScheduledTransactionsRoutes(fastify, pool);
  registerSyncRoutes(fastify, pool);
  registerTransactionsRoutes(fastify, pool, queue);
  // Not a committed product feature yet, only a real route for #10's global
  // preHandlers to protect ahead of the Budget API's own routes (#235).
  if (config.nodeEnv !== "production") {
    registerMeRoute(fastify);
  }

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
