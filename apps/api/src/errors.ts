import { assertTextLength, isValidationError } from "@envelope/core";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Maps a `packages/core` (or repository-level, same codes) `ValidationError`
 * to a 400 response carrying its stable `code` and `details` — never its
 * English `.message`, per the "no user-facing text in core" rule. Returns
 * whether it handled the error, so a caller can rethrow anything else.
 */
export async function sendIfValidationError(reply: FastifyReply, error: unknown): Promise<boolean> {
  if (!isValidationError(error)) {
    return false;
  }
  await reply.code(400).send({ error: error.code, details: error.details });
  return true;
}

/** One name or free-text field of a request body: its name in the body, its value, and its limit. */
export type TextFieldCheck = readonly [field: string, value: unknown, max: number];

/**
 * Checks every given text field against its limit with `assertTextLength` (#507) and, for the
 * first one over it, answers 400 `text_too_long` with `{ field, max }`. A value that is not a
 * string (a field the client did not send) is skipped: whether it is required is the route's
 * own concern. Returns whether it answered, so the route stops there.
 */
export async function sendIfTextTooLong(reply: FastifyReply, checks: readonly TextFieldCheck[]): Promise<boolean> {
  for (const [field, value, max] of checks) {
    if (typeof value !== "string") {
      continue;
    }
    try {
      assertTextLength(value, max, field);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return true;
      }
      throw error;
    }
  }
  return false;
}

/** What the global error handler answers: a status and a body that never carries an error's own message. */
export interface ErrorReply {
  readonly statusCode: number;
  readonly body: { readonly error: string; readonly code?: string; readonly details?: unknown };
}

const FOREIGN_KEY_VIOLATION = "23503";
const INVALID_TEXT_REPRESENTATION = "22P02";
const INSUFFICIENT_PRIVILEGE = "42501";

/** Fastify's own client errors keep their status; their body names the status, not Fastify's message. */
const CLIENT_ERROR_NAMES: Readonly<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  406: "not_acceptable",
  408: "request_timeout",
  413: "payload_too_large",
  414: "uri_too_long",
  415: "unsupported_media_type",
  429: "too_many_requests",
  431: "request_header_fields_too_large",
};

/**
 * The SQLSTATE of an error PostgreSQL raised, as node-postgres reports it (`code`, alongside a
 * `severity`), or undefined for anything else. Duck-typed, like `isBrokerageOffBudgetViolation`,
 * since only `db/pool.ts` imports `pg` itself (ADR 0005).
 */
function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && typeof severity === "string" ? code : undefined;
}

/** PostgreSQL reports a row refused by a Row-Level Security policy as 42501; match its wording too. */
function isRowLevelSecurityViolation(error: unknown): boolean {
  const { message } = error as { message?: unknown };
  return typeof message === "string" && message.includes("row-level security");
}

/**
 * Maps any error a route or hook throws to the reply the global error handler sends (#512). A
 * database error never reaches the client as itself: its message names tables and constraints,
 * and two different errors for the same request could tell a caller whether another workspace
 * holds a row with a given id. Routes still check what they can first (that an account id
 * belongs to the workspace, a `ValidationError` answered by `sendIfValidationError`); this is the
 * safety net behind them.
 */
export function toErrorReply(error: unknown): ErrorReply {
  if (isValidationError(error)) {
    return { statusCode: 400, body: { error: error.code, details: error.details } };
  }

  const sqlState = sqlStateOf(error);
  if (sqlState !== undefined) {
    if (sqlState === FOREIGN_KEY_VIOLATION) {
      return { statusCode: 400, body: { error: "invalid_reference" } };
    }
    if (sqlState === INVALID_TEXT_REPRESENTATION) {
      return { statusCode: 400, body: { error: "invalid_input" } };
    }
    if (sqlState === INSUFFICIENT_PRIVILEGE || isRowLevelSecurityViolation(error)) {
      return { statusCode: 403, body: { error: "forbidden" } };
    }
    return { statusCode: 500, body: { error: "internal_error" } };
  }

  if (typeof error === "object" && error !== null) {
    const { statusCode, code } = error as { statusCode?: unknown; code?: unknown };
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      return {
        statusCode,
        body: {
          error: CLIENT_ERROR_NAMES[statusCode] ?? "client_error",
          ...(typeof code === "string" && code.startsWith("FST_") ? { code } : {}),
        },
      };
    }
  }

  return { statusCode: 500, body: { error: "internal_error" } };
}

/**
 * Installs `toErrorReply` as the app's error handler (#512). A 500 logs the whole error
 * server-side, the only place its message and stack go; a mapped client error logs it at `info`.
 * The request's database transaction is rolled back either way: by `onError`, or by `onSend` for
 * any reply of 400 or more (`auth/workspace-membership.ts`), whichever runs first, the other
 * finding no connection left to release.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (error, request, reply) => {
    const { statusCode, body } = toErrorReply(error);
    if (statusCode >= 500) {
      request.log.error({ err: error }, "unhandled error");
    } else {
      request.log.info({ err: error }, "request failed with a client error");
    }
    await reply.code(statusCode).send(body);
  });
}
