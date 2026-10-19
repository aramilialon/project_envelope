import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler, requireOwnerRole } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";
import { createWorkspace, deleteWorkspace } from "../workspaces/repository.ts";

/**
 * `POST /workspaces` (`#394`): creates a workspace with the signed-in user as its own first
 * member, `owner`. Not workspace-scoped — there is no membership yet to check, only the
 * global token/user-mapper preHandlers `app.ts` already applies. `DELETE /workspaces/:workspaceId`
 * removes one outright, owner-only (`requireOwnerRole`): every workspace-scoped table cascades
 * from it in one shot (migration 0008).
 */
export function registerWorkspacesRoutes(app: FastifyInstance, pool: DbPool): void {
  app.post("/workspaces", async (request, reply) => {
    if (!request.userId) {
      throw new Error("registerWorkspacesRoutes: request.userId was not set — is the user mapper preHandler registered?");
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const baseCurrency = typeof body.baseCurrency === "string" ? body.baseCurrency : "";
    const timeZone = typeof body.timeZone === "string" ? body.timeZone : "";
    if (!name || !baseCurrency || !timeZone) {
      await reply.code(400).send({ error: "invalid workspace: name, baseCurrency and timeZone are required" });
      return;
    }

    try {
      const workspace = await createWorkspace(pool, request.userId, { name, baseCurrency, timeZone });
      await reply.code(201).send(workspace);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.delete(
    "/workspaces/:workspaceId",
    { preHandler: [createWorkspaceMembershipPreHandler(pool), requireOwnerRole] },
    async (request, reply) => {
      await deleteWorkspace(request.db!, request.workspace!.id);
      await reply.code(204).send();
    },
  );
}
