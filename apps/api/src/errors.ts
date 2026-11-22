import { assertTextLength, isValidationError, ValidationError } from "@envelope/core";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * The status of a `ValidationError`: 400, except "amount_total_overflow" (#651), 422. That one
 * is not about the request: the rows already stored add up beyond what can be computed exactly,
 * and its `details` name them.
 */
export function validationErrorStatus(error: ValidationError): 400 | 422 {
  return error.code === "amount_total_overflow" ? 422 : 400;
}

/**
 * Maps a `packages/core` (or repository-level, same codes) `ValidationError`
 * to a 400 (or, for "amount_total_overflow", 422) response carrying its stable `code` and
 * `details` — never its English `.message`, per the "no user-facing text in core" rule. Returns
 * whether it handled the error, so a caller can rethrow anything else.
 */
export async function sendIfValidationError(reply: FastifyReply, error: unknown): Promise<boolean> {
  if (!isValidationError(error)) {
    return false;
  }
  await reply.code(validationErrorStatus(error)).send({ error: error.code, details: error.details });
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

/**
 * A strict request body (#655, #713): the body as a record of fields, refusing what a route would
 * otherwise drop without a word. A missing body reads as `{}`.
 *
 * @throws ValidationError `invalid_body` for a body that is not a JSON object (an array, a string,
 *   a number, `null`), and `unknown_field` with `details.field` for the first key that is not in
 *   `allowed`: a misspelt field, or one the request cannot change (an id, the account). Either is
 *   a 400 through `sendIfValidationError` or the global error handler.
 * @param where what `details.field` starts with, for an object nested in the body: `"from."` names
 *   an unknown key `fees` of a trade's `from` leg `from.fees` (#594).
 */
export function strictBody(body: unknown, allowed: ReadonlySet<string>, where = ""): Record<string, unknown> {
  if (body === undefined) {
    return {};
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("invalid_body", "the body must be a JSON object");
  }
  const fields = body as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new ValidationError("unknown_field", `"${where}${unknown}" is not a field of this request`, { field: `${where}${unknown}` });
  }
  return fields;
}

/**
 * A field of the right name but the wrong JSON type or value (#655): a 400 `invalid_field` with
 * `details.field` naming it, through `sendIfValidationError` or the global error handler.
 */
export function invalidField(field: string): ValidationError {
  return new ValidationError("invalid_field", `${field} has the wrong type or value`, { field });
}

/** What the global error handler answers: a status and a body that never carries an error's own message. */
export interface ErrorReply {
  readonly statusCode: number;
  readonly body: { readonly error: string; readonly code?: string; readonly details?: unknown };
}

/**
 * A request over one of the API's rate limits (#566, ADR 0017). The global handler answers it 429
 * `too_many_requests` with `details.retryAfterSeconds`; the limiter has already set `Retry-After`.
 */
export class TooManyRequestsError extends Error {
  readonly statusCode = 429;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many requests");
    this.name = "TooManyRequestsError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * A write a repository refuses because an account it touches is closed (#741), checked before any
 * replay or other check that could fail for another reason. The global handler answers it as it
 * answers migration 0033's trigger: 409 `account_closed`.
 */
export class AccountClosedError extends Error {
  readonly accountId: string;

  constructor(accountId: string) {
    super("the account is closed");
    this.name = "AccountClosedError";
    this.accountId = accountId;
  }
}

const FOREIGN_KEY_VIOLATION = "23503";
const INVALID_TEXT_REPRESENTATION = "22P02";
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
/** A date or time PostgreSQL cannot read ("not-a-date") or one that does not exist ("2026-02-30"). */
const INVALID_DATETIME_FORMAT = "22007";
const DATETIME_FIELD_OVERFLOW = "22008";

/**
 * The constraint migration 0033's trigger names when it refuses a write to a closed account (#729,
 * ADR 0018): a transaction, split, trade, scheduled transaction or reconciliation of an account
 * whose `closed_at` is set.
 */
export const ACCOUNT_CLOSED_CONSTRAINT = "account_closed";

/** Whether `error` is PostgreSQL refusing a write to a closed account through migration 0033's trigger. */
export function isAccountClosedViolation(error: unknown): boolean {
  if (sqlStateOf(error) !== CHECK_VIOLATION) {
    return false;
  }
  const { constraint } = error as { constraint?: unknown };
  return constraint === ACCOUNT_CLOSED_CONSTRAINT;
}

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
    return { statusCode: validationErrorStatus(error), body: { error: error.code, details: error.details } };
  }

  if (error instanceof AccountClosedError) {
    return { statusCode: 409, body: { error: "account_closed" } };
  }

  const sqlState = sqlStateOf(error);
  if (sqlState !== undefined) {
    // A write to a closed account (#729, ADR 0018): refused by the database for every write path,
    // and answered as a conflict with the account's state, which the client can explain.
    if (isAccountClosedViolation(error)) {
      return { statusCode: 409, body: { error: "account_closed" } };
    }
    if (sqlState === FOREIGN_KEY_VIOLATION) {
      return { statusCode: 400, body: { error: "invalid_reference" } };
    }
    if (sqlState === INVALID_TEXT_REPRESENTATION) {
      return { statusCode: 400, body: { error: "invalid_input" } };
    }
    // The safety net behind the routes' own date checks (#655): a date that reached a query
    // unchecked is the request's fault, not the server's.
    if (sqlState === INVALID_DATETIME_FORMAT || sqlState === DATETIME_FIELD_OVERFLOW) {
      return { statusCode: 400, body: { error: "invalid_date" } };
    }
    if (sqlState === INSUFFICIENT_PRIVILEGE || isRowLevelSecurityViolation(error)) {
      return { statusCode: 403, body: { error: "forbidden" } };
    }
    return { statusCode: 500, body: { error: "internal_error" } };
  }

  if (error instanceof TooManyRequestsError) {
    return { statusCode: 429, body: { error: "too_many_requests", details: { retryAfterSeconds: error.retryAfterSeconds } } };
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

/** Never logged (#512): a database error's `detail` can carry a whole row (a CHECK or NOT NULL failure). */
export const LOG_REDACT_PATHS: readonly string[] = ["err.detail"];

/**
 * Installs `toErrorReply` as the app's error handler (#512). A 500 logs the whole error
 * server-side, the only place its message and stack go (`buildApp` redacts `err.detail`, which for
 * a CHECK or NOT NULL failure carries the whole row). A mapped client error logs only its `code`
 * and status: a JSON parse error or an invalid-input message quotes the request's own data. A
 * permission or Row-Level Security refusal from the database logs at `warn`, still answering 403,
 * since a missing GRANT would otherwise go unnoticed at `info`.
 *
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
      const sqlState = sqlStateOf(error);
      const { code } = error as { code?: unknown };
      const summary = { code: sqlState ?? (typeof code === "string" ? code : undefined), statusCode };
      if (sqlState !== undefined && statusCode === 403) {
        request.log.warn(summary, "the database refused a request: check its grants and Row-Level Security policies");
      } else {
        request.log.info(summary, "request failed with a client error");
      }
    }
    await reply.code(statusCode).send(body);
  });
}
