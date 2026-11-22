import { assertDate } from "@envelope/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createWorkspaceMembershipPreHandler } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { getCurrentDate } from "../days-of-buffer/repository.ts";
import { sendIfValidationError } from "../errors.ts";
import { isUuid } from "../ids.ts";
import { getPortfolio } from "../portfolios/repository.ts";
import { accountPositions, portfolioPositions } from "../positions/repository.ts";
import { requireAccountOfWorkspace } from "./account-ownership.ts";

/**
 * The date the positions are as of (#719): `?asOf=YYYY-MM-DD`, or today in the workspace's time
 * zone, the day an account's balance is as of (#702). For a malformed one (a repeated parameter
 * included) it sends 400 `invalid_date` and answers undefined.
 */
async function asOfDate(request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const { asOf } = (request.query ?? {}) as { asOf?: unknown };
  try {
    if (asOf === undefined) {
      return await getCurrentDate(request.db!, request.workspace!.id);
    }
    const value = typeof asOf === "string" ? asOf : String(asOf);
    assertDate(value);
    return value;
  } catch (error) {
    if (await sendIfValidationError(reply, error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Positions (#79), rebuilt from the trades on every request: `GET .../portfolios/:portfolioId/positions`
 * (an archived portfolio included) and `GET .../accounts/:accountId/positions`, as of `?asOf=`, by
 * default today in the workspace's time zone (#719). Any member reads. Another workspace's, an
 * unknown or a malformed id is a 404; a malformed date a 400 `invalid_date`.
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
    const asOf = await asOfDate(request, reply);
    if (asOf === undefined) {
      return;
    }
    return portfolioPositions(request.db!, request.workspace!.id, portfolio.id, asOf);
  });

  app.get(
    "/workspaces/:workspaceId/accounts/:accountId/positions",
    { preHandler: [preHandler, requireAccountOfWorkspace] },
    async (request, reply) => {
      const { accountId } = request.params as { accountId: string };
      const asOf = await asOfDate(request, reply);
      if (asOf === undefined) {
        return;
      }
      // The rows are matched in JavaScript too, where an upper-case UUID would not equal the stored one.
      return accountPositions(request.db!, request.workspace!.id, accountId.toLowerCase(), asOf);
    },
  );
}
