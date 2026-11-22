/**
 * Idempotent creates over HTTP (#559, ADR 0020): the `Idempotency-Key` header.
 *
 * - A route opts in with `config: IDEMPOTENT_ROUTE` and wraps its handler in `withIdempotencyKey`;
 *   its success paths send through `sendAndRemember`, which stores the reply on the claimed key
 *   before sending it. Adding a route takes those three changes.
 * - `checkIdempotencyKeyHeader`, a global preHandler, refuses the header (400 `invalid_field`,
 *   `details.field: "Idempotency-Key"`) on a write route that does not take it, so a client never
 *   believes a create was protected when it was not, and refuses a key that is not one UUID (a
 *   repeated header, or two joined by a comma, included). GET and HEAD ignore the header.
 * - Order of checks on a route that takes it: authentication, membership, write role, the path's
 *   own rows (404), then the key: a replay or a conflict comes before validation, so a retry of a
 *   stored success gets the same answer even when the state has changed since (a category deleted,
 *   an account closed), then validation and the domain checks.
 * - Lock order: the key is the request's first lock (idempotency/repository.ts).
 * - Only a success is kept: a 4xx or 5xx rolls the request back, key included, so a corrected
 *   retry under the same key goes through. A success sent without storing its reply is refused
 *   twice over: `assertIdempotentReplyStored` (called from the request transaction's onSend hook)
 *   turns it into a 500, and the deferred trigger of migration 0039 refuses to commit the key.
 * - A conflict's reply never carries the stored request or reply, and neither is ever logged.
 */
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";

import { IdConflictError, invalidField } from "../errors.ts";
import { isUuid } from "../ids.ts";
import { requestFingerprint } from "./fingerprint.ts";
import { claimIdempotencyKey, storeIdempotentReply } from "./repository.ts";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
/** On a reply sent again from a stored one; exposed to the web app through CORS (app.ts). */
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";

interface ClaimedKey {
  readonly workspaceId: string;
  readonly key: string;
  stored: boolean;
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** The route takes an `Idempotency-Key` header (#559). */
    idempotent?: boolean;
  }
  interface FastifyRequest {
    idempotencyKey?: ClaimedKey;
  }
}

/** The route option that lets a route take the header: `{ config: IDEMPOTENT_ROUTE }`. */
export const IDEMPOTENT_ROUTE = { idempotent: true } as const;

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Global preHandler, after authentication and before any route's own preHandlers (app.ts).
 *
 * @throws ValidationError `invalid_field` (`details.field: "Idempotency-Key"`) for the header on a
 *   write route that does not take it, or for a value that is not one UUID.
 */
export async function checkIdempotencyKeyHeader(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const value = request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
  if (value === undefined || READ_METHODS.has(request.method)) {
    return;
  }
  if (request.routeOptions.config.idempotent !== true || typeof value !== "string" || !isUuid(value)) {
    throw invalidField(IDEMPOTENCY_KEY_HEADER);
  }
}

/** The request's key, in lower case, or undefined when it sent none. */
function keyOf(request: FastifyRequest): string | undefined {
  const value = request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

/**
 * Wraps an idempotent route's handler: without a key it runs as before; with one it claims the
 * key, then sends the stored reply (marked `Idempotent-Replayed: true`, nothing written), refuses a
 * different request with 409 `id_conflict`, or runs the handler with the key claimed.
 *
 * @throws ValidationError `invalid_body` for a body that cannot be fingerprinted (fingerprint.ts).
 * @throws IdConflictError, RequestInProgressError (the global error handler answers both 409).
 */
export function withIdempotencyKey(handler: RouteHandlerMethod): RouteHandlerMethod {
  return async function idempotentHandler(this: unknown, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const key = keyOf(request);
    if (key === undefined) {
      return handler.call(this as never, request as never, reply as never);
    }
    const workspaceId = request.workspace!.id;
    const route = request.routeOptions.url ?? request.url;
    const requestHash = requestFingerprint({
      method: request.method,
      route,
      params: request.params,
      query: request.query,
      body: request.body,
      userId: request.userId!,
    });
    const outcome = await claimIdempotencyKey(request.db!, {
      workspaceId,
      key,
      userId: request.userId!,
      operation: route,
      requestHash,
    });
    if (outcome.kind === "conflict") {
      throw new IdConflictError(IDEMPOTENCY_KEY_HEADER);
    }
    if (outcome.kind === "replay") {
      await reply.header(IDEMPOTENT_REPLAYED_HEADER, "true").code(outcome.status).send(outcome.body);
      return undefined;
    }
    request.idempotencyKey = { workspaceId, key, stored: false };
    return handler.call(this as never, request as never, reply as never);
  };
}

/**
 * Sends an idempotent route's success, after storing it on the request's claimed key, if any, in
 * the request's own transaction: the key and the reply commit together with what the request wrote.
 */
export async function sendAndRemember(request: FastifyRequest, reply: FastifyReply, status: number, body: unknown): Promise<void> {
  const claimed = request.idempotencyKey;
  if (claimed && !claimed.stored) {
    // Stored as the JSON the client receives (a Date becomes its ISO string), so a replay is the same.
    const sent: unknown = body === undefined ? null : JSON.parse(JSON.stringify(body));
    await storeIdempotentReply(request.db!, claimed.workspaceId, claimed.key, status, sent);
    claimed.stored = true;
  }
  await reply.code(status).send(body);
}

/**
 * Called by the request transaction's onSend hook before it commits: a success whose claimed key
 * has no stored reply is a bug in the route, refused here rather than committing a key that
 * would replay nothing.
 *
 * @throws Error for such a reply; the hook rolls back first, and the error handler answers 500.
 */
export function assertIdempotentReplyStored(request: FastifyRequest, statusCode: number): void {
  const claimed = request.idempotencyKey;
  if (claimed && !claimed.stored && statusCode < 400) {
    throw new Error("an idempotent route replied without storing its reply");
  }
}
