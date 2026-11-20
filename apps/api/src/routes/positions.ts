import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { isUuid } from "../ids.ts";
import { getPortfolio } from "../portfolios/repository.ts";
import { accountPositions, portfolioPositions } from "../positions/repository.ts";
import { requireAccountOfWorkspace } from "./account-ownership.ts";

/**
 * Positions (#79), rebuilt from the trades on every request: `GET .../portfolios/:portfolioId/positions`
 * (an archived portfolio included) and `GET .../accounts/:accountId/positions`. Any member reads.
 * Another workspace's, an unknown or a malformed id is a 404.
 */
export function registerPositionsRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);

  app.get("/workspaces/:workspaceId/portfolios/:portfolioId/positions", { preHandler }, async (request, reply) => {
    const { portfolioId } = request.params as { portfolioId: string };
    const portfolio = isUuid(portfolioId) ? await getPortfolio(request.db!, request.workspace!.id, portfolioId) : undefined;
    if (!portfolio) {
      await reply.code(404).send({ error: "portfolio not found" });
      return;
    }
    return portfolioPositions(request.db!, request.workspace!.id, portfolio.id);
  });

  app.get(
    "/workspaces/:workspaceId/accounts/:accountId/positions",
    { preHandler: [preHandler, requireAccountOfWorkspace] },
    async (request) => {
      const { accountId } = request.params as { accountId: string };
      // The rows are matched in JavaScript too, where an upper-case UUID would not equal the stored one.
      return accountPositions(request.db!, request.workspace!.id, accountId.toLowerCase());
    },
  );
}
