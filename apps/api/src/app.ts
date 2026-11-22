import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { createAuthPreHandler, createTokenVerifier } from "./auth/token-verifier.ts";
import { createUserMapperPreHandler } from "./auth/user-mapper.ts";
import { registerWorkspaceScope } from "./auth/workspace-membership.ts";
import type { Config } from "./config.ts";
import { createPool, type DbPool } from "./db/pool.ts";
import { LOG_REDACT_PATHS, registerErrorHandler } from "./errors.ts";
import { rejectMalformedIdParams } from "./ids.ts";
import type { QueueDriver } from "./queue/index.ts";
import { createUserRateLimitPreHandler, registerAddressRateLimit } from "./rate-limit.ts";
import { registerAccountsRoutes } from "./routes/accounts.ts";
import { registerAssignmentsRoutes } from "./routes/assignments.ts";
import { registerBudgetRoutes } from "./routes/budget.ts";
import { registerCategoriesRoutes } from "./routes/categories.ts";
import { registerDaysOfBufferRoutes } from "./routes/days-of-buffer.ts";
import { registerDeviceTokensRoutes } from "./routes/device-tokens.ts";
import { registerFxRatesRoutes } from "./routes/fx-rates.ts";
import { registerGoalsRoutes } from "./routes/goals.ts";
import { registerHealthRoute } from "./routes/health.ts";
import { registerImportRoutes } from "./routes/import.ts";
import { registerInstrumentsRoutes, registerWorkspaceInstrumentsRoutes } from "./routes/instruments.ts";
import { registerMeRoute } from "./routes/me.ts";
import { registerMyWorkspacesRoute } from "./routes/my-workspaces.ts";
import { registerPortfoliosRoutes } from "./routes/portfolios.ts";
import { registerPositionsRoutes } from "./routes/positions.ts";
import { registerQuickAssignRoutes } from "./routes/quick-assign.ts";
import { registerReconciliationRoutes } from "./routes/reconciliation.ts";
import { registerScheduledTransactionsRoutes } from "./routes/scheduled-transactions.ts";
import { registerSyncRoutes } from "./routes/sync.ts";
import { registerTransactionsRoutes } from "./routes/transactions.ts";
import { registerTradesRoutes } from "./routes/trades.ts";
import { registerWorkspacesRoutes } from "./routes/workspaces.ts";

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
 * every existing test that builds an app without one keeps working unchanged. `vapidPublicKey`,
 * when given, registers the Web Push opt-in routes (`#61`); omitted (most existing tests, which
 * have no VAPID config of their own), they simply do not exist, the same accommodation `queue`
 * already makes.
 */
export function buildApp(config: Config, queue?: QueueDriver, vapidPublicKey?: string): App {
  const redact = [...LOG_REDACT_PATHS];
  const loggerOptions = config.logPretty
    ? { level: config.logLevel, redact, transport: { target: "pino-pretty" } }
    : { level: config.logLevel, redact };

  // Only the configured proxies' `X-Forwarded-For` is believed (#566): with none, `request.ip` is the
  // connection's own address, so a client cannot pick the address its requests are counted under.
  const fastify = Fastify({ logger: loggerOptions, trustProxy: config.trustProxy.length > 0 ? [...config.trustProxy] : false });
  const pool = createPool(config.databaseUrl);

  // The web app (#48) calls this API from its own origin; nothing else needs to.
  // `@fastify/cors`'s own default `methods` is "GET,HEAD,POST" (not every verb this API uses),
  // which silently blocked every PATCH/PUT/DELETE endpoint from a real browser until #315.
  // `Retry-After` is not a CORS-safelisted response header: without exposing it, the web app could
  // not read how long a 429 asks it to wait (#566). A CORS preflight is answered in this plugin's
  // own `onRequest` hook, before the rate limits below, and never counted.
  void fastify.register(cors, {
    origin: config.webOrigin,
    methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"],
    exposedHeaders: ["Retry-After"],
  });

  // Before authentication: the health check and requests with a bad token count too (ADR 0017).
  registerAddressRateLimit(fastify, config.rateLimit);

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
  // Keyed on the user the token verified, so one member's requests never use up another's.
  fastify.addHook("preHandler", skipPublicPaths(createUserRateLimitPreHandler(fastify, config.rateLimit)));
  // After authentication, so a caller without a token still gets 401, and before any route's own
  // preHandlers, so a malformed id never takes a database connection (#512).
  fastify.addHook("preHandler", rejectMalformedIdParams);
  // A thrown error never reaches the client as itself: no database message, table or constraint (#512).
  registerErrorHandler(fastify);

  registerWorkspaceScope(fastify);
  registerHealthRoute(fastify, pool);
  registerAccountsRoutes(fastify, pool);
  registerAssignmentsRoutes(fastify, pool);
  registerBudgetRoutes(fastify, pool);
  registerCategoriesRoutes(fastify, pool);
  registerDaysOfBufferRoutes(fastify, pool);
  if (vapidPublicKey) {
    registerDeviceTokensRoutes(fastify, pool, vapidPublicKey);
  }
  registerFxRatesRoutes(fastify, pool);
  registerGoalsRoutes(fastify, pool);
  registerImportRoutes(fastify, pool);
  registerInstrumentsRoutes(fastify, pool);
  registerWorkspaceInstrumentsRoutes(fastify, pool);
  registerMyWorkspacesRoute(fastify, pool);
  registerPortfoliosRoutes(fastify, pool);
  registerPositionsRoutes(fastify, pool);
  registerQuickAssignRoutes(fastify, pool);
  registerReconciliationRoutes(fastify, pool);
  registerScheduledTransactionsRoutes(fastify, pool, queue);
  registerSyncRoutes(fastify, pool);
  registerTransactionsRoutes(fastify, pool, queue);
  registerTradesRoutes(fastify, pool);
  registerWorkspacesRoutes(fastify, pool);
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
