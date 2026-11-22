/**
 * The API's request limits (#566, ADR 0017), in process with `@fastify/rate-limit` and its
 * in-memory store:
 *
 * - per client address, on `onRequest`, before anything else runs: every route counts, the
 *   health check and requests with a bad or missing token included, so neither can be used to
 *   load the database or the token verifier without limit;
 * - per user, as a preHandler right after the user mapper, keyed on the verified user id (never
 *   on a claim read from an unverified token): every request, then writes, then file imports (a statement or a price file), each
 *   with its own, stricter limit.
 *
 * A request over a limit gets 429 `too_many_requests` through the global error handler, with
 * `Retry-After`. The counters live in this process: they reset on restart, and running more than
 * one API process would need a shared store (ADR 0017).
 */
import rateLimit, { type RateLimitOptions } from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { RateLimitConfig } from "./config.ts";
import { TooManyRequestsError } from "./errors.ts";

const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The file imports, the most expensive writes: a bank statement (#55), parsed and matched against
 * the account's transactions, and a file of closing prices (#83), up to 20,000 rows at once.
 */
const IMPORT_ROUTES: ReadonlySet<string> = new Set([
  "/workspaces/:workspaceId/accounts/:accountId/import",
  "/workspaces/:workspaceId/instruments/:instrumentId/prices/import",
]);

/**
 * How many distinct keys (addresses, or users) each limiter's in-memory store keeps; the least
 * recently seen is dropped first. Every limiter (the per-address one and the three per-user ones)
 * has its own store, so the option is passed to each: the plugin's root `cache` option reaches
 * only its global limit, which this API does not use. Far more than a household needs, small
 * enough to stay a few megabytes per store.
 */
const STORE_SIZE = 10_000;

/**
 * Registers the plugin and the per-address limit. The limit's hook is added once the plugin has
 * loaded (`after`), which also puts it after `@fastify/cors`'s own `onRequest` hook: a CORS preflight
 * is answered there and never counted, and a 429 still carries the CORS headers the web app needs
 * to read it (`Retry-After` among the exposed ones).
 */
export function registerAddressRateLimit(fastify: FastifyInstance, config: RateLimitConfig): void {
  void fastify.register(rateLimit, {
    global: false,
    hook: "onRequest",
    errorResponseBuilder: (_request, context) => new TooManyRequestsError(Math.ceil(context.ttl / 1000)),
  });
  void fastify.after(() => {
    fastify.addHook(
      "onRequest",
      // The plugin's own key: `request.ip` (which `trustProxy` decides), an IPv6 address counted by its /64.
      fastify.rateLimit({ max: config.addressMax, timeWindow: config.addressWindowMs, cache: STORE_SIZE }),
    );
  });
}

type Limiter = ReturnType<FastifyInstance["createRateLimit"]>;

/**
 * The per-user limits, for a preHandler that runs after the user mapper has set `request.userId`.
 * The limiters themselves are built on the first request, once `registerAddressRateLimit`'s plugin
 * has loaded and `createRateLimit` exists.
 */
export function createUserRateLimitPreHandler(fastify: FastifyInstance, config: RateLimitConfig) {
  let limiters: { all: Limiter; writes: Limiter; imports: Limiter } | undefined;
  const limiter = (bucket: string, max: number): Limiter => {
    // `createRateLimit` honours `cache` (its store is sized from the merged options) although its
    // option type leaves it out; `RateLimitOptions` has it.
    const options: RateLimitOptions = {
      max,
      timeWindow: config.userWindowMs,
      cache: STORE_SIZE,
      keyGenerator: (request) => `${bucket}:${request.userId ?? ""}`,
    };
    return fastify.createRateLimit(options);
  };

  return async function userRateLimitPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (request.userId === undefined) {
      return;
    }
    limiters ??= {
      all: limiter("user", config.userMax),
      writes: limiter("user-write", config.userWriteMax),
      imports: limiter("user-import", config.userImportMax),
    };
    await check(limiters.all, request, reply);
    if (WRITE_METHODS.has(request.method)) {
      await check(limiters.writes, request, reply);
      if (request.routeOptions.url !== undefined && IMPORT_ROUTES.has(request.routeOptions.url)) {
        await check(limiters.imports, request, reply);
      }
    }
  };
}

async function check(limiter: Limiter, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await limiter(request);
  if (!result.isAllowed && result.isExceeded) {
    void reply.header("retry-after", result.ttlInSeconds);
    throw new TooManyRequestsError(result.ttlInSeconds);
  }
}
