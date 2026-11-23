import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import {
  claimAssignmentBatch,
  createAssignmentBatch,
  undoAssignmentBatch,
  undoAssignmentEntry,
  type AssignmentEntryInput,
} from "../assignments/repository.ts";
import { listCategories } from "../categories/repository.ts";
import type { DbPool } from "../db/pool.ts";
import { invalidField, sendIfValidationError } from "../errors.ts";
import { valueFingerprint } from "../idempotency/fingerprint.ts";
import { IDEMPOTENT_REPLAYED_HEADER, IDEMPOTENT_ROUTE, sendAndRemember, withIdempotencyKey } from "../idempotency/route.ts";
import { isUuid } from "../ids.ts";

function parseEntries(body: Record<string, unknown>): AssignmentEntryInput[] | undefined {
  const raw = body.entries;
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const entries: AssignmentEntryInput[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return undefined;
    }
    const { month, sourceCategoryId, destinationCategoryId, amountCents } = item as Record<string, unknown>;
    if (typeof month !== "string") {
      return undefined;
    }
    if (sourceCategoryId !== null && typeof sourceCategoryId !== "string") {
      return undefined;
    }
    if (destinationCategoryId !== null && typeof destinationCategoryId !== "string") {
      return undefined;
    }
    if (typeof amountCents !== "number") {
      return undefined;
    }
    entries.push({ month, sourceCategoryId, destinationCategoryId, amountCents });
  }
  return entries;
}

/**
 * The body's optional `batchId` (#559, ADR 0020), in lower case.
 *
 * @throws ValidationError `invalid_field` (`details.field: "batchId"`) for anything but a UUID.
 */
export function parseBatchId(body: Record<string, unknown>): string | undefined {
  if (body.batchId === undefined) {
    return undefined;
  }
  if (!isUuid(body.batchId)) {
    throw invalidField("batchId");
  }
  return body.batchId.toLowerCase();
}

/**
 * Claims the client's batch id before validation (the same place as an `Idempotency-Key`'s replay):
 * true when the same request already wrote this batch, whose rows have then been sent again (201,
 * `Idempotent-Replayed: true`); false when the id is now claimed for this request.
 *
 * @throws IdConflictError when the id is used for another request (409 `id_conflict`).
 */
export async function replayClaimedBatch(
  request: FastifyRequest,
  reply: FastifyReply,
  batchId: string,
  what: readonly unknown[],
): Promise<boolean> {
  const claim = await claimAssignmentBatch(request.db!, request.workspace!.id, batchId, valueFingerprint([...what, request.userId!]));
  if (claim.kind === "claimed") {
    return false;
  }
  void reply.header(IDEMPOTENT_REPLAYED_HEADER, "true");
  await sendAndRemember(request, reply, 201, { entries: claim.entries });
  return true;
}

export function registerAssignmentsRoutes(app: FastifyInstance, pool: DbPool): void {
  // Every route here writes to the ledger, so the write guard applies uniformly (#24).
  const preHandler = withWriteAccess(createWorkspaceMembershipPreHandler(pool));

  app.post(
    "/workspaces/:workspaceId/assignments",
    { preHandler, config: IDEMPOTENT_ROUTE },
    withIdempotencyKey(async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const batchId = parseBatchId(body);
      if (batchId !== undefined && (await replayClaimedBatch(request, reply, batchId, ["assignments", body.entries ?? null]))) {
        return;
      }
      const entries = parseEntries(body);
      if (!entries) {
        await reply.code(400).send({ error: "invalid assignment batch: a non-empty entries array is required" });
        return;
      }

      const categories = await listCategories(request.db!, request.workspace!.id);
      const categoryIds = new Set(categories.map((c) => c.id));
      for (const entry of entries) {
        for (const categoryId of [entry.sourceCategoryId, entry.destinationCategoryId]) {
          if (categoryId !== null && !categoryIds.has(categoryId)) {
            await reply.code(400).send({ error: `categoryId "${categoryId}" does not name a category of this workspace` });
            return;
          }
        }
      }

      try {
        const created = await createAssignmentBatch(request.db!, {
          workspaceId: request.workspace!.id,
          author: request.userId!,
          entries,
          ...(batchId !== undefined ? { batchId } : {}),
        });
        await sendAndRemember(request, reply, 201, { entries: created });
      } catch (error) {
        if (await sendIfValidationError(reply, error)) {
          return;
        }
        throw error;
      }
    }),
  );

  app.post(
    "/workspaces/:workspaceId/assignment-batches/:batchId/undo",
    { preHandler, config: IDEMPOTENT_ROUTE },
    withIdempotencyKey(async (request, reply) => {
      const { batchId } = request.params as { batchId: string };
      const result = await undoAssignmentBatch(request.db!, request.workspace!.id, batchId, request.userId!);
      if (result === "not_found") {
        await reply.code(404).send({ error: "assignment batch not found" });
        return;
      }
      await sendAndRemember(request, reply, 201, { entries: result });
    }),
  );

  app.post(
    "/workspaces/:workspaceId/assignments/:entryId/undo",
    { preHandler, config: IDEMPOTENT_ROUTE },
    withIdempotencyKey(async (request, reply) => {
      const { entryId } = request.params as { entryId: string };
      const result = await undoAssignmentEntry(request.db!, request.workspace!.id, entryId, request.userId!);
      if (result === "not_found") {
        await reply.code(404).send({ error: "assignment entry not found" });
        return;
      }
      if (result === "already_reversed") {
        await reply.code(409).send({ error: "this assignment entry has already been undone" });
        return;
      }
      await sendAndRemember(request, reply, 201, { entries: result });
    }),
  );
}
