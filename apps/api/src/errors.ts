import { assertTextLength, isValidationError } from "@envelope/core";
import type { FastifyReply } from "fastify";

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
