import { isValidationError } from "@envelope/core";
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
