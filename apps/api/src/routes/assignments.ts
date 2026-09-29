import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler, requireWriteAccess } from "../auth/workspace-membership.ts";
import {
  createAssignmentBatch,
  undoAssignmentBatch,
  undoAssignmentEntry,
  type AssignmentEntryInput,
} from "../assignments/repository.ts";
import { listCategories } from "../categories/repository.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";

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

export function registerAssignmentsRoutes(app: FastifyInstance, pool: DbPool): void {
  // Every route here writes to the ledger, so the write guard applies uniformly (#24).
  const preHandler = [createWorkspaceMembershipPreHandler(pool), requireWriteAccess];

  app.post("/workspaces/:workspaceId/assignments", { preHandler }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
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
      });
      await reply.code(201).send({ entries: created });
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.post("/workspaces/:workspaceId/assignment-batches/:batchId/undo", { preHandler }, async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const result = await undoAssignmentBatch(request.db!, request.workspace!.id, batchId, request.userId!);
    if (result === "not_found") {
      await reply.code(404).send({ error: "assignment batch not found" });
      return;
    }
    await reply.code(201).send({ entries: result });
  });

  app.post("/workspaces/:workspaceId/assignments/:entryId/undo", { preHandler }, async (request, reply) => {
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
    await reply.code(201).send({ entries: result });
  });
}
