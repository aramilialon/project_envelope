import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";
import { isUuid } from "../ids.ts";
import { portfolioPerformance } from "../performance/repository.ts";
import { getPortfolio } from "../portfolios/repository.ts";

/**
 * A portfolio's monthly performance (#89): `GET .../portfolios/:portfolioId/performance?from=YYYY-MM&to=YYYY-MM`,
 * an archived portfolio included. Any member reads. Computed on every request from the trades and
 * the stored prices and rates (`@envelope/core`'s `monthlyPerformance`), never stored or cached,
 * and never fetching anything.
 *
 * Each month: its value at its last day (the current month's today, in the workspace's time
 * zone), net contributions, income, gain, the time- and money-weighted returns in millionths, the
 * oldest price and rate dates used, and what is `missing` when a figure is unknown (null, never
 * 0); then the same figures over the whole range (`totals`). Every amount is in the workspace's
 * base currency.
 *
 * Refusals: 404 "portfolio not found" for another workspace's, an unknown or a malformed id (the
 * body the malformed-id check sends); 400 `invalid_month` (`details.field`) for a missing or
 * malformed `from` or `to`, a `to` before `from`, or a `to` after the current month (with
 * `details.max`); 400 `range_too_long` (`details.months`, `details.max`) for more than 120 months.
 */
export function registerPerformanceRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);

  app.get("/workspaces/:workspaceId/portfolios/:portfolioId/performance", { preHandler }, async (request, reply) => {
    const { portfolioId } = request.params as { portfolioId: string };
    const portfolio = isUuid(portfolioId) ? await getPortfolio(request.db!, request.workspace!.id, portfolioId) : undefined;
    if (!portfolio) {
      await reply.code(404).send({ error: "portfolio not found" });
      return;
    }
    const { from, to } = (request.query ?? {}) as { from?: unknown; to?: unknown };
    try {
      return await portfolioPerformance(request.db!, request.workspace!.id, portfolio.id, from, to);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });
}
