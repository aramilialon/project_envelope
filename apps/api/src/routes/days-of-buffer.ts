import { assertDate } from "@envelope/core";
import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler } from "../auth/workspace-membership.ts";
import { getCurrentDate, getDaysOfBuffer } from "../days-of-buffer/repository.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";

export function registerDaysOfBufferRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);

  app.get("/workspaces/:workspaceId/days-of-buffer", { preHandler }, async (request, reply) => {
    const { asOf: queryAsOf } = request.query as { asOf?: string };
    try {
      const asOf = queryAsOf ?? (await getCurrentDate(request.db!, request.workspace!.id));
      assertDate(asOf);
      const daysOfBuffer = await getDaysOfBuffer(request.db!, request.workspace!.id, asOf);
      return { asOf, daysOfBuffer };
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });
}
