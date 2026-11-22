import { assertMonth } from "@envelope/core";
import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import { listCategoryGroups } from "../categories/repository.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";
import { IDEMPOTENT_ROUTE, sendAndRemember, withIdempotencyKey } from "../idempotency/route.ts";
import { runQuickAssign, type QuickAssignMode, type QuickAssignScope } from "../quick-assign/repository.ts";
import { parseBatchId, replayClaimedBatch } from "./assignments.ts";

const MODES: readonly QuickAssignMode[] = [
  "fund_targets",
  "cover_overspending",
  "cover_card_debt",
  "repeat_assigned",
  "repeat_spent",
];

function parseScope(body: Record<string, unknown>): QuickAssignScope | string {
  const scope = body.scope;
  if (typeof scope !== "object" || scope === null) {
    return "scope is required";
  }
  const kind = (scope as Record<string, unknown>).kind;
  if (kind === "all") {
    return { kind: "all" };
  }
  if (kind === "group") {
    const groupId = (scope as Record<string, unknown>).groupId;
    if (typeof groupId !== "string") {
      return "scope.groupId is required when scope.kind is \"group\"";
    }
    return { kind: "group", groupId };
  }
  return "scope.kind must be \"all\" or \"group\"";
}

export function registerQuickAssignRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = withWriteAccess(createWorkspaceMembershipPreHandler(pool));

  // An `Idempotency-Key`, or a `batchId` the client chose (#559): a retry of a run that already
  // assigned gets that run's entries, instead of computing and appending a second run.
  app.post("/workspaces/:workspaceId/quick-assign", { preHandler, config: IDEMPOTENT_ROUTE }, withIdempotencyKey(async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const batchId = parseBatchId(body);
    if (
      batchId !== undefined &&
      (await replayClaimedBatch(request, reply, batchId, ["quick-assign", body.month ?? null, body.mode ?? null, body.scope ?? null]))
    ) {
      return;
    }
    const month = typeof body.month === "string" ? body.month : "";
    const mode = typeof body.mode === "string" && MODES.includes(body.mode as QuickAssignMode) ? (body.mode as QuickAssignMode) : undefined;
    const scope = parseScope(body);

    if (!month || !mode) {
      await reply.code(400).send({ error: `invalid quick assign: month and a mode (one of ${MODES.join(", ")}) are required` });
      return;
    }
    if (typeof scope === "string") {
      await reply.code(400).send({ error: `invalid quick assign: ${scope}` });
      return;
    }
    if (scope.kind === "group") {
      const groups = await listCategoryGroups(request.db!, request.workspace!.id);
      if (!groups.some((g) => g.id === scope.groupId)) {
        await reply.code(400).send({ error: `groupId "${scope.groupId}" does not name a category group of this workspace` });
        return;
      }
    }

    try {
      assertMonth(month);
      const entries = await runQuickAssign(request.db!, request.workspace!.id, request.userId!, month, scope, mode, batchId);
      await sendAndRemember(request, reply, 201, { entries });
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  }));
}
