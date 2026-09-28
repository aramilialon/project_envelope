import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";
import {
  createTransaction,
  listTransactionsForAccount,
  updateTransaction,
  type SplitInput,
  type TransactionStatus,
} from "../transactions/repository.ts";

const STATUSES: readonly TransactionStatus[] = ["pending", "cleared", "reconciled"];

function parseSplits(body: Record<string, unknown>): SplitInput[] | undefined {
  const raw = body.splits;
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const splits: SplitInput[] = [];
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
    splits.push({
      categoryId,
      amountCents,
      ...(typeof memo === "string" ? { memo } : {}),
    });
  }
  return splits;
}

export function registerTransactionsRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const base = "/workspaces/:workspaceId/accounts/:accountId/transactions";

  app.post(base, { preHandler }, async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const splits = parseSplits(body);
    const occurredAt = typeof body.occurredAt === "string" ? body.occurredAt : "";
    if (!splits || !occurredAt) {
      await reply.code(400).send({ error: "invalid transaction: occurredAt and a non-empty splits array are required" });
      return;
    }
    const status = typeof body.status === "string" && STATUSES.includes(body.status as TransactionStatus)
      ? (body.status as TransactionStatus)
      : undefined;

    try {
      const transaction = await createTransaction(request.db!, {
        workspaceId: request.workspace!.id,
        accountId,
        occurredAt,
        splits,
        ...(typeof body.payee === "string" ? { payee: body.payee } : {}),
        ...(typeof body.memo === "string" ? { memo: body.memo } : {}),
        ...(status ? { status } : {}),
        ...(typeof body.amountCents === "number" ? { amountCents: body.amountCents } : {}),
      });
      await reply.code(201).send(transaction);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.get(base, { preHandler }, async (request) => {
    const { accountId } = request.params as { accountId: string };
    const transactions = await listTransactionsForAccount(request.db!, request.workspace!.id, accountId);
    return { transactions };
  });

  app.patch(`${base}/:transactionId`, { preHandler }, async (request, reply) => {
    const { transactionId } = request.params as { transactionId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const splits = body.splits === undefined ? undefined : parseSplits(body);
    if (body.splits !== undefined && !splits) {
      await reply.code(400).send({ error: "splits, when given, must be a non-empty array" });
      return;
    }
    const status = typeof body.status === "string" && STATUSES.includes(body.status as TransactionStatus)
      ? (body.status as TransactionStatus)
      : undefined;

    try {
      const result = await updateTransaction(request.db!, request.workspace!.id, transactionId, {
        ...(typeof body.payee === "string" ? { payee: body.payee } : {}),
        ...(typeof body.memo === "string" ? { memo: body.memo } : {}),
        ...(status ? { status } : {}),
        ...(splits ? { splits } : {}),
        ...(typeof body.amountCents === "number" ? { amountCents: body.amountCents } : {}),
      });
      if (result === "not_found") {
        await reply.code(404).send({ error: "transaction not found" });
        return;
      }
      if (result === "reconciled") {
        await reply.code(409).send({ error: "a reconciled transaction cannot be edited; unlock it first" });
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
}
