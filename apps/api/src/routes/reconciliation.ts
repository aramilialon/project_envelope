import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler, requireWriteAccess } from "../auth/workspace-membership.ts";
import { listCategories } from "../categories/repository.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";
import {
  getReconciliationCandidates,
  reconcileAccount,
  unlockReconciledTransaction,
  type ReconciliationAdjustment,
} from "../reconciliation/repository.ts";

function parseAdjustment(body: Record<string, unknown>): ReconciliationAdjustment | undefined | "invalid" {
  const raw = body.adjustment;
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) {
    return "invalid";
  }
  const { categoryId, memo } = raw as Record<string, unknown>;
  if (categoryId !== null && typeof categoryId !== "string") {
    return "invalid";
  }
  return { categoryId, ...(typeof memo === "string" ? { memo } : {}) };
}

export function registerReconciliationRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const writePreHandler = [preHandler, requireWriteAccess];
  const base = "/workspaces/:workspaceId/accounts/:accountId";

  app.get(`${base}/reconciliation-candidates`, { preHandler }, async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const { date } = request.query as { date?: string };
    if (!date) {
      await reply.code(400).send({ error: "a date query parameter is required" });
      return;
    }
    try {
      const candidates = await getReconciliationCandidates(request.db!, request.workspace!.id, accountId, date);
      return candidates;
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.post(`${base}/reconciliations`, { preHandler: writePreHandler }, async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const date = typeof body.date === "string" ? body.date : "";
    const statementBalanceCents = typeof body.statementBalanceCents === "number" ? body.statementBalanceCents : undefined;
    const tickedTransactionIds = Array.isArray(body.tickedTransactionIds)
      ? body.tickedTransactionIds.filter((id): id is string => typeof id === "string")
      : undefined;
    if (!date || statementBalanceCents === undefined || !tickedTransactionIds) {
      await reply.code(400).send({
        error: "invalid reconciliation: date, statementBalanceCents and a tickedTransactionIds array are required",
      });
      return;
    }
    const adjustment = parseAdjustment(body);
    if (adjustment === "invalid") {
      await reply.code(400).send({ error: "invalid adjustment: categoryId (a string or null) is required" });
      return;
    }
    if (adjustment && adjustment.categoryId) {
      const categories = await listCategories(request.db!, request.workspace!.id);
      if (!categories.some((c) => c.id === adjustment.categoryId)) {
        await reply.code(400).send({ error: `categoryId "${adjustment.categoryId}" does not name a category of this workspace` });
        return;
      }
    }

    try {
      const result = await reconcileAccount(request.db!, request.workspace!.id, {
        accountId,
        date,
        statementBalanceCents,
        tickedTransactionIds,
        userId: request.userId!,
        ...(adjustment ? { adjustment } : {}),
      });
      await reply.code(result.outcome === "reconciled" ? 201 : 200).send(result);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.post(
    "/workspaces/:workspaceId/transactions/:transactionId/unlock-reconciliation",
    { preHandler: writePreHandler },
    async (request, reply) => {
      const { transactionId } = request.params as { transactionId: string };
      const result = await unlockReconciledTransaction(request.db!, request.workspace!.id, transactionId, request.userId!);
      if (result === "not_found") {
        await reply.code(404).send({ error: "transaction not found" });
        return;
      }
      if (result === "not_reconciled") {
        await reply.code(409).send({ error: "only a reconciled transaction can be unlocked" });
        return;
      }
      return result;
    },
  );
}
