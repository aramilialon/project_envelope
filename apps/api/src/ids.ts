import type { FastifyReply, FastifyRequest } from "fastify";

/** Every id the API hands out is a PostgreSQL `uuid`; this is its text form, in any letter case. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` can name a row at all. Checked before an id from a request reaches a query: a
 * malformed one names nothing, and PostgreSQL would otherwise refuse it as invalid input (#512).
 */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Global preHandler (#512), registered after authentication: every path parameter named `…Id`
 * names a row by its uuid, so a malformed one answers 404, the same as a well-formed id that
 * names nothing, before the route takes a database connection. `workspaceId` is left to the
 * membership check, which answers a malformed one like any workspace the caller is not a member
 * of (403).
 */
export async function rejectMalformedIdParams(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const params = (request.params ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(params)) {
    if (name === "workspaceId" || !name.endsWith("Id")) {
      continue;
    }
    if (!isUuid(value)) {
      await reply.code(404).send({ error: `${describeIdParam(name)} not found` });
      return;
    }
  }
}

/** "scheduledTransactionId" → "scheduled transaction", matching the routes' own 404 messages. */
function describeIdParam(name: string): string {
  return name
    .slice(0, -"Id".length)
    .replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}
