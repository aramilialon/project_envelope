import { assertMonth } from "@envelope/core";
import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler } from "../auth/workspace-membership.ts";
import { getBudgetMonth, listBudgetProblems } from "../budget/repository.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";

export function registerBudgetRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);

  app.get("/workspaces/:workspaceId/budget-months/:month", { preHandler }, async (request, reply) => {
    const { month } = request.params as { month: string };
    try {
      assertMonth(month);
      const budgetMonth = await getBudgetMonth(request.db!, request.workspace!.id, month);
      return budgetMonth;
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.get("/workspaces/:workspaceId/budget-months/:month/problems", { preHandler }, async (request, reply) => {
    const { month } = request.params as { month: string };
    try {
      assertMonth(month);
      const problems = await listBudgetProblems(request.db!, request.workspace!.id, month);
      return { problems };
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });
}
