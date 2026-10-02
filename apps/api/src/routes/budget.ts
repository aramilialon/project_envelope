import { assertMonth } from "@envelope/core";
import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler } from "../auth/workspace-membership.ts";
import { getBudgetMonth, listBudgetProblems } from "../budget/repository.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";
import { listScheduledEventsForMonth } from "../scheduled-transactions/repository.ts";
import { listTransactionEventsForMonth } from "../transactions/repository.ts";

/** `TransactionEvent | ScheduledEvent`, merged and sorted — what the budget month's timeline and the account register's own (#325, #326, #337) are both built from. */
interface MonthEvent {
  readonly date: string;
  readonly amountCents: number;
  readonly payee: string | null;
  readonly categoryId: string | null;
  readonly kind: "recorded" | "pending" | "scheduled";
  readonly scheduledTransactionId?: string;
}

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

  app.get("/workspaces/:workspaceId/budget-months/:month/events", { preHandler }, async (request, reply) => {
    const { month } = request.params as { month: string };
    const { accountId } = request.query as { accountId?: string };
    try {
      assertMonth(month);
      const [transactionEvents, scheduledEvents] = await Promise.all([
        listTransactionEventsForMonth(request.db!, request.workspace!.id, month, accountId),
        listScheduledEventsForMonth(request.db!, request.workspace!.id, month, accountId),
      ]);
      const events: MonthEvent[] = [...transactionEvents, ...scheduledEvents].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      return { events };
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });
}
