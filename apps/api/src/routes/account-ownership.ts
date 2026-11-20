import type { FastifyReply, FastifyRequest } from "fastify";

import { accountExists } from "../accounts/repository.ts";
import { isUuid } from "../ids.ts";

/**
 * Answers 404 unless `accountId`, taken from the request (a path parameter or a body field),
 * names an account of the request's own workspace (#512); returns whether it answered, so the
 * route stops there. A malformed id answers the same 404 without reaching the database. For a
 * route behind `createWorkspaceMembershipPreHandler`, which sets `request.db` and
 * `request.workspace`.
 */
export async function sendIfAccountNotFound(request: FastifyRequest, reply: FastifyReply, accountId: unknown): Promise<boolean> {
  if (isUuid(accountId) && (await accountExists(request.db!, request.workspace!.id, accountId))) {
    return false;
  }
  await reply.code(404).send({ error: "account not found" });
  return true;
}

/**
 * Route preHandler for every route under `/workspaces/:workspaceId/accounts/:accountId/…` that
 * does not already look the account up itself, chained after the membership check (and
 * `requireWriteAccess` on a write): the path's account must belong to the workspace (#512).
 */
export async function requireAccountOfWorkspace(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { accountId } = (request.params ?? {}) as { accountId?: unknown };
  await sendIfAccountNotFound(request, reply, accountId);
}
