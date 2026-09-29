import { assertMonth } from "@envelope/core";
import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler, requireWriteAccess } from "../auth/workspace-membership.ts";
import { listCategoryGroups } from "../categories/repository.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";
import { runQuickAssign, type QuickAssignMode, type QuickAssignScope } from "../quick-assign/repository.ts";

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
  const preHandler = [createWorkspaceMembershipPreHandler(pool), requireWriteAccess];

  app.post("/workspaces/:workspaceId/quick-assign", { preHandler }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
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
      const entries = await runQuickAssign(request.db!, request.workspace!.id, request.userId!, month, scope, mode);
      await reply.code(201).send({ entries });
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });
}
