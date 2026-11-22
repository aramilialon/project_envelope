import { MAX_NAME_LENGTH } from "@envelope/core";
import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler, requireOwnerRole } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfTextTooLong, sendIfValidationError, strictBody } from "../errors.ts";
import { createWorkspace, deleteWorkspace, setWorkspaceTaxCountry } from "../workspaces/repository.ts";

/**
 * `POST /workspaces` (`#394`): creates a workspace with the signed-in user as its own first
 * member, `owner`. Not workspace-scoped — there is no membership yet to check, only the
 * global token/user-mapper preHandlers `app.ts` already applies. `DELETE /workspaces/:workspaceId`
 * removes one outright, owner-only (`requireOwnerRole`): every workspace-scoped table cascades
 * from it in one shot (migration 0008). `PATCH /workspaces/:workspaceId` changes a workspace
 * setting, owner-only too; today only its tax country (`#508`).
 *
 * Both bodies are strict (#713): a key that is not one of the request's own fields (a misspelt
 * `taxcountry`, an `id`, the time zone a workspace keeps once created) is a 400 `unknown_field`
 * naming it, before anything else is checked or written.
 */
/** Every field `POST /workspaces` takes (#713). */
const CREATE_KEYS: ReadonlySet<string> = new Set(["name", "baseCurrency", "timeZone"]);

/** Every field `PATCH /workspaces/:workspaceId` takes (#713). */
const PATCH_KEYS: ReadonlySet<string> = new Set(["taxCountry"]);

export function registerWorkspacesRoutes(app: FastifyInstance, pool: DbPool): void {
  app.patch(
    "/workspaces/:workspaceId",
    { preHandler: [createWorkspaceMembershipPreHandler(pool), requireOwnerRole] },
    async (request, reply) => {
      const body = strictBody(request.body, PATCH_KEYS);
      const taxCountry = body.taxCountry;
      if (taxCountry === undefined || (taxCountry !== null && typeof taxCountry !== "string")) {
        await reply.code(400).send({ error: "invalid workspace settings: taxCountry (a country code, or null) is required" });
        return;
      }

      try {
        const workspace = await setWorkspaceTaxCountry(request.db!, request.workspace!.id, taxCountry);
        if (!workspace) {
          await reply.code(404).send({ error: "workspace not found" });
          return;
        }
        return workspace;
      } catch (error) {
        if (await sendIfValidationError(reply, error)) {
          return;
        }
        throw error;
      }
    },
  );

  app.post("/workspaces", async (request, reply) => {
    if (!request.userId) {
      throw new Error("registerWorkspacesRoutes: request.userId was not set — is the user mapper preHandler registered?");
    }
    const body = strictBody(request.body, CREATE_KEYS);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const baseCurrency = typeof body.baseCurrency === "string" ? body.baseCurrency : "";
    const timeZone = typeof body.timeZone === "string" ? body.timeZone : "";
    if (!name || !baseCurrency || !timeZone) {
      await reply.code(400).send({ error: "invalid workspace: name, baseCurrency and timeZone are required" });
      return;
    }
    if (await sendIfTextTooLong(reply, [["name", name, MAX_NAME_LENGTH]])) {
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
