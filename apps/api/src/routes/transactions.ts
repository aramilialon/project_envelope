import { assertDate, MAX_FREE_TEXT_LENGTH, ValidationError } from "@envelope/core";
import type { FastifyInstance, FastifyReply } from "fastify";

import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import { listCategories } from "../categories/repository.ts";
import type { DbPool } from "../db/pool.ts";
import { invalidField, sendIfTextTooLong, sendIfValidationError, strictBody, type TextFieldCheck } from "../errors.ts";
import { IDEMPOTENT_ROUTE, sendAndRemember, withIdempotencyKey } from "../idempotency/route.ts";
import type { QueueDriver } from "../queue/index.ts";
import {
  createTransaction,
  createTransfer,
  deleteTransaction,
  listTransactionsForAccount,
  UnknownCategoryError,
  updateTransaction,
  type SplitInput,
  type TransactionStatus,
} from "../transactions/repository.ts";
import { requireAccountOfWorkspace } from "./account-ownership.ts";

const STATUSES: readonly TransactionStatus[] = ["pending", "cleared", "reconciled"];

/** Every field a `PATCH` of a transaction takes (#655); anything else is a 400 `unknown_field`. */
const PATCH_KEYS: ReadonlySet<string> = new Set(["payee", "memo", "status", "splits", "amountCents", "occurredAt"]);

/**
 * A date with a time and an optional offset ("Z" or "+02:00"; without one, the time is in the
 * workspace's time zone, as `insertTransactionRow` anchors it). Group 1 is the date.
 */
const INSTANT_PATTERN = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * A new transaction's `occurredAt` (#655): a real "YYYY-MM-DD" date, or that date with a time
 * (`INSTANT_PATTERN`), which the create routes have always taken (a client that knows the time;
 * the random walk sends those). Anything else, "2026-02-30", "2026-1-5" or "not-a-date" included, is a 400 `invalid_date`;
 * a time that does not exist ("25:00") is left to the error handler's safety net, same code.
 *
 * @throws ValidationError "invalid_date".
 */
function assertOccurredAt(value: string): void {
  const date = INSTANT_PATTERN.exec(value)?.[1] ?? value;
  try {
    assertDate(date);
  } catch {
    throw new ValidationError("invalid_date", `not a valid date: "${value}"`, { value });
  }
}

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

/**
 * The free-text fields of a transaction (or scheduled transaction) body, each with its limit
 * (#507): the payee, the memo and every split's memo. The payee takes the longer free-text limit,
 * not the name one, because a file import stores a bank's whole description in it.
 */
export function transactionTextChecks(
  body: Record<string, unknown>,
  splits: readonly { readonly memo?: string }[] | undefined,
): TextFieldCheck[] {
  return [
    ["payee", body.payee, MAX_FREE_TEXT_LENGTH],
    ["memo", body.memo, MAX_FREE_TEXT_LENGTH],
    ...(splits ?? []).map((split, index): TextFieldCheck => [`splits[${index}].memo`, split.memo, MAX_FREE_TEXT_LENGTH]),
  ];
}

/**
 * A 409 for a trade's cash leg (ADR 0012): its amount, account and date belong to the trade, and it
 * goes only with the trade. `code` lets a client tell it apart from the reconciled lock.
 */
async function sendTradeOwned(reply: FastifyReply, reason: string): Promise<void> {
  await reply.code(409).send({ error: `this transaction is the cash leg of a trade: ${reason}`, code: "trade_owned_transaction" });
}

/** The first split's categoryId that does not name a category of this workspace, if any. */
function findUnknownCategoryId(categoryIds: ReadonlySet<string>, splits: readonly SplitInput[]): string | undefined {
  return splits.map((s) => s.categoryId).find((id): id is string => id !== null && !categoryIds.has(id));
}

export function registerTransactionsRoutes(app: FastifyInstance, pool: DbPool, queue?: QueueDriver): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const writePreHandler = withWriteAccess(preHandler);
  const base = "/workspaces/:workspaceId/accounts/:accountId/transactions";

  // Creating or listing names the account in its path, which must belong to the workspace (#512);
  // editing or deleting looks the transaction itself up in the workspace, and answers 404 when it
  // is not on the account the path names (#655).
  // An `Idempotency-Key` (#559, ADR 0020) is claimed after the path account check and before the
  // body is validated: a retry of a stored success gets the same reply.
  const idempotent = { config: IDEMPOTENT_ROUTE };

  app.post(base, { preHandler: [...writePreHandler, requireAccountOfWorkspace], ...idempotent }, withIdempotencyKey(async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const splits = parseSplits(body);
    const occurredAt = typeof body.occurredAt === "string" ? body.occurredAt : "";
    if (!splits || !occurredAt) {
      await reply.code(400).send({ error: "invalid transaction: occurredAt and a non-empty splits array are required" });
      return;
    }
    // A real date, or an instant on one (#655): "2026-02-30" or "2026-1-5" is a 400 `invalid_date`.
    assertOccurredAt(occurredAt);
    if (await sendIfTextTooLong(reply, transactionTextChecks(body, splits))) {
      return;
    }
    const status = typeof body.status === "string" && STATUSES.includes(body.status as TransactionStatus)
      ? (body.status as TransactionStatus)
      : undefined;

    const categories = await listCategories(request.db!, request.workspace!.id);
    const categoryIds = new Set(categories.map((c) => c.id));
    const unknownCategoryId = findUnknownCategoryId(categoryIds, splits);
    if (unknownCategoryId) {
      await reply.code(400).send({ error: `categoryId "${unknownCategoryId}" does not name a category of this workspace` });
      return;
    }

    try {
      const transaction = await createTransaction(
        request.db!,
        {
          workspaceId: request.workspace!.id,
          accountId,
          occurredAt,
          splits,
          ...(typeof body.payee === "string" ? { payee: body.payee } : {}),
          ...(typeof body.memo === "string" ? { memo: body.memo } : {}),
          ...(status ? { status } : {}),
          ...(typeof body.amountCents === "number" ? { amountCents: body.amountCents } : {}),
        },
        queue,
      );
      await sendAndRemember(request, reply, 201, transaction);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  }));

  app.get(base, { preHandler: [preHandler, requireAccountOfWorkspace] }, async (request) => {
    const { accountId } = request.params as { accountId: string };
    const transactions = await listTransactionsForAccount(request.db!, request.workspace!.id, accountId);
    return { transactions };
  });

  // A strict body (#655): a field the edit would otherwise drop without a word (an unknown or
  // misspelt key, `accountId`, an id) is a 400 `unknown_field`; a field of the wrong type, or a
  // status that is none of the three, a 400 `invalid_field`; a date that does not exist, `invalid_date`.
  app.patch(`${base}/:transactionId`, { preHandler: writePreHandler }, async (request, reply) => {
    const { accountId, transactionId } = request.params as { accountId: string; transactionId: string };
    const body = strictBody(request.body, PATCH_KEYS);
    for (const field of ["payee", "memo", "occurredAt"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "string") {
        throw invalidField(field);
      }
    }
    if (body.amountCents !== undefined && typeof body.amountCents !== "number") {
      throw invalidField("amountCents");
    }
    if (body.status !== undefined && !STATUSES.includes(body.status as TransactionStatus)) {
      throw invalidField("status");
    }
    const occurredAt = body.occurredAt as string | undefined;
    if (occurredAt !== undefined) {
      assertDate(occurredAt);
    }
    const splits = body.splits === undefined ? undefined : parseSplits(body);
    if (body.splits !== undefined && !splits) {
      await reply.code(400).send({ error: "splits, when given, must be a non-empty array" });
      return;
    }
    if (await sendIfTextTooLong(reply, transactionTextChecks(body, splits))) {
      return;
    }

    try {
      // The unknown-category check runs in the repository, after the path-account and
      // closed-account checks (#655).
      const result = await updateTransaction(
        request.db!,
        request.workspace!.id,
        transactionId,
        {
          ...(typeof body.payee === "string" ? { payee: body.payee } : {}),
          ...(typeof body.memo === "string" ? { memo: body.memo } : {}),
          ...(body.status !== undefined ? { status: body.status as TransactionStatus } : {}),
          ...(splits ? { splits } : {}),
          ...(typeof body.amountCents === "number" ? { amountCents: body.amountCents } : {}),
          ...(occurredAt !== undefined ? { occurredAt } : {}),
        },
        accountId,
      );
      if (result === "not_found") {
        await reply.code(404).send({ error: "transaction not found" });
        return;
      }
      if (result === "reconciled") {
        await reply.code(409).send({ error: "a reconciled transaction cannot be edited; unlock it first" });
        return;
      }
      if (result === "trade_owned") {
        await sendTradeOwned(reply, "its amount and date come from the trade; edit the trade instead");
        return;
      }
      return result;
    } catch (error) {
      if (error instanceof UnknownCategoryError) {
        await reply.code(400).send({ error: error.message });
        return;
      }
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.delete(`${base}/:transactionId`, { preHandler: writePreHandler }, async (request, reply) => {
    const { accountId, transactionId } = request.params as { accountId: string; transactionId: string };
    const result = await deleteTransaction(request.db!, request.workspace!.id, transactionId, request.userId!, accountId);
    if (result === "not_found") {
      await reply.code(404).send({ error: "transaction not found" });
      return;
    }
    if (result === "reconciled") {
      await reply.code(409).send({ error: "a reconciled transaction cannot be deleted; unlock it first" });
      return;
    }
    if (result === "trade_owned") {
      await sendTradeOwned(reply, "it is deleted with its trade");
      return;
    }
    await reply.code(204).send();
  });

  app.post("/workspaces/:workspaceId/transfers", { preHandler: writePreHandler, ...idempotent }, withIdempotencyKey(async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const sourceAccountId = typeof body.sourceAccountId === "string" ? body.sourceAccountId : "";
    const destinationAccountId = typeof body.destinationAccountId === "string" ? body.destinationAccountId : "";
    const occurredAt = typeof body.occurredAt === "string" ? body.occurredAt : "";
    const amountCents = typeof body.amountCents === "number" ? body.amountCents : undefined;
    if (!sourceAccountId || !destinationAccountId || !occurredAt || amountCents === undefined) {
      await reply.code(400).send({
        error: "invalid transfer: sourceAccountId, destinationAccountId, occurredAt and amountCents are required",
      });
      return;
    }
    assertOccurredAt(occurredAt);
    if (await sendIfTextTooLong(reply, transactionTextChecks(body, undefined))) {
      return;
    }
    const status = typeof body.status === "string" && STATUSES.includes(body.status as TransactionStatus)
      ? (body.status as TransactionStatus)
      : undefined;
    const categoryId = typeof body.categoryId === "string" ? body.categoryId : undefined;
    if (categoryId !== undefined) {
      const categories = await listCategories(request.db!, request.workspace!.id);
      if (!categories.some((c) => c.id === categoryId)) {
        await reply.code(400).send({ error: `categoryId "${categoryId}" does not name a category of this workspace` });
        return;
      }
    }

    try {
      const transfer = await createTransfer(
        request.db!,
        {
          workspaceId: request.workspace!.id,
          sourceAccountId,
          destinationAccountId,
          occurredAt,
          amountCents,
          ...(typeof body.payee === "string" ? { payee: body.payee } : {}),
          ...(typeof body.memo === "string" ? { memo: body.memo } : {}),
          ...(status ? { status } : {}),
          ...(categoryId !== undefined ? { categoryId } : {}),
        },
        queue,
      );
      await sendAndRemember(request, reply, 201, transfer);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  }));
}
