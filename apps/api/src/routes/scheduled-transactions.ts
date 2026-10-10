import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler, requireWriteAccess } from "../auth/workspace-membership.ts";
import { listCategories } from "../categories/repository.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";
import type { QueueDriver } from "../queue/index.ts";
import {
  createScheduledTransaction,
  deleteScheduledTransaction,
  listScheduledTransactions,
  recordScheduledTransaction,
  skipScheduledTransaction,
  updateScheduledTransaction,
  type RecurUnit,
  type ScheduledSplitInput,
} from "../scheduled-transactions/repository.ts";

const RECUR_UNITS: readonly RecurUnit[] = ["day", "month", "year"];

function parseScheduledSplits(body: Record<string, unknown>): ScheduledSplitInput[] | undefined {
  const raw = body.splits;
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const splits: ScheduledSplitInput[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return undefined;
    }
    const { categoryId, amountCents, memo } = item as Record<string, unknown>;
    if (categoryId !== null && typeof categoryId !== "string") {
      return undefined;
    }
    if (typeof amountCents !== "number") {
      return undefined;
    }
    splits.push({ categoryId, amountCents, ...(typeof memo === "string" ? { memo } : {}) });
  }
  return splits;
}

/** The first split's categoryId that does not name a category of this workspace, if any — `null` (income, #347) always names one of its own, since there is none to look up. */
function findUnknownCategoryId(categoryIds: ReadonlySet<string>, splits: readonly ScheduledSplitInput[]): string | undefined {
  return splits.map((s) => s.categoryId).find((id): id is string => id !== null && !categoryIds.has(id));
}

export function registerScheduledTransactionsRoutes(app: FastifyInstance, pool: DbPool, queue?: QueueDriver): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const writePreHandler = [preHandler, requireWriteAccess];
  const base = "/workspaces/:workspaceId/scheduled-transactions";

  app.post(base, { preHandler: writePreHandler }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const splits = parseScheduledSplits(body);
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    const nextDueDate = typeof body.nextDueDate === "string" ? body.nextDueDate : "";
    const recurEvery = body.recurEvery;
    const recurUnit = body.recurUnit;
    if (
      !splits ||
      !accountId ||
      !nextDueDate ||
      typeof recurEvery !== "number" ||
      typeof recurUnit !== "string" ||
      !RECUR_UNITS.includes(recurUnit as RecurUnit)
    ) {
      await reply.code(400).send({
        error:
          "invalid scheduled transaction: accountId, nextDueDate, recurEvery, a valid recurUnit and a non-empty splits array are required",
      });
      return;
    }

    const categories = await listCategories(request.db!, request.workspace!.id);
    const categoryIds = new Set(categories.map((c) => c.id));
    const unknownCategoryId = findUnknownCategoryId(categoryIds, splits);
    if (unknownCategoryId) {
      await reply.code(400).send({ error: `categoryId "${unknownCategoryId}" does not name a category of this workspace` });
      return;
    }

    try {
      const scheduledTransaction = await createScheduledTransaction(request.db!, {
        workspaceId: request.workspace!.id,
        accountId,
        nextDueDate,
        recurEvery,
        recurUnit: recurUnit as RecurUnit,
        splits,
        ...(typeof body.payee === "string" ? { payee: body.payee } : {}),
        ...(typeof body.memo === "string" ? { memo: body.memo } : {}),
        ...(typeof body.amountCents === "number" ? { amountCents: body.amountCents } : {}),
      });
      await reply.code(201).send(scheduledTransaction);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.get(base, { preHandler }, async (request) => {
    const scheduledTransactions = await listScheduledTransactions(request.db!, request.workspace!.id);
    return { scheduledTransactions };
  });

  app.patch(`${base}/:scheduledTransactionId`, { preHandler: writePreHandler }, async (request, reply) => {
    const { scheduledTransactionId } = request.params as { scheduledTransactionId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const splits = body.splits === undefined ? undefined : parseScheduledSplits(body);
    if (body.splits !== undefined && !splits) {
      await reply.code(400).send({ error: "splits, when given, must be a non-empty array" });
      return;
    }
    const recurUnit = body.recurUnit;
    if (recurUnit !== undefined && (typeof recurUnit !== "string" || !RECUR_UNITS.includes(recurUnit as RecurUnit))) {
      await reply.code(400).send({ error: `recurUnit, when given, must be one of ${RECUR_UNITS.join(", ")}` });
      return;
    }

    if (splits) {
      const categories = await listCategories(request.db!, request.workspace!.id);
      const categoryIds = new Set(categories.map((c) => c.id));
      const unknownCategoryId = findUnknownCategoryId(categoryIds, splits);
      if (unknownCategoryId) {
        await reply.code(400).send({ error: `categoryId "${unknownCategoryId}" does not name a category of this workspace` });
        return;
      }
    }

    try {
      const result = await updateScheduledTransaction(request.db!, request.workspace!.id, scheduledTransactionId, {
        ...(typeof body.payee === "string" ? { payee: body.payee } : {}),
        ...(typeof body.memo === "string" ? { memo: body.memo } : {}),
        ...(typeof body.nextDueDate === "string" ? { nextDueDate: body.nextDueDate } : {}),
        ...(typeof body.recurEvery === "number" ? { recurEvery: body.recurEvery } : {}),
        ...(recurUnit !== undefined ? { recurUnit: recurUnit as RecurUnit } : {}),
        ...(splits ? { splits } : {}),
        ...(typeof body.amountCents === "number" ? { amountCents: body.amountCents } : {}),
      });
      if (!result) {
        await reply.code(404).send({ error: "scheduled transaction not found" });
        return;
      }
      return result;
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.delete(`${base}/:scheduledTransactionId`, { preHandler: writePreHandler }, async (request, reply) => {
    const { scheduledTransactionId } = request.params as { scheduledTransactionId: string };
    const removed = await deleteScheduledTransaction(request.db!, request.workspace!.id, scheduledTransactionId);
    if (!removed) {
      await reply.code(404).send({ error: "scheduled transaction not found" });
      return;
    }
    await reply.code(204).send();
  });

  app.post(`${base}/:scheduledTransactionId/record`, { preHandler: writePreHandler }, async (request, reply) => {
    const { scheduledTransactionId } = request.params as { scheduledTransactionId: string };
    try {
      const result = await recordScheduledTransaction(request.db!, request.workspace!.id, scheduledTransactionId, queue);
      if (!result) {
        await reply.code(404).send({ error: "scheduled transaction not found" });
        return;
      }
      await reply.code(201).send(result);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.post(`${base}/:scheduledTransactionId/skip`, { preHandler: writePreHandler }, async (request, reply) => {
    const { scheduledTransactionId } = request.params as { scheduledTransactionId: string };
    const result = await skipScheduledTransaction(request.db!, request.workspace!.id, scheduledTransactionId);
    if (!result) {
      await reply.code(404).send({ error: "scheduled transaction not found" });
      return;
    }
    return result;
  });
}
