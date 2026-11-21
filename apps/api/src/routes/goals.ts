import { assertMonth } from "@envelope/core";
import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import { listCategories } from "../categories/repository.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";
import { assertGoalAmount, deleteGoal, getGoalProgress, listGoalProgress, upsertGoal, type GoalInput, type GoalKind, type RepeatInterval } from "../goals/repository.ts";

const KINDS: readonly GoalKind[] = ["monthly", "by_date", "repeating", "balance"];
const INTERVALS: readonly RepeatInterval[] = [2, 3, 4, 6, 12, 24];

/**
 * Reads a goal from the request body. Returns a string for a body of the wrong shape (a plain
 * 400), and throws a `ValidationError` for an `amountCents` that is a number but not a valid goal
 * amount: 0 or less, not a whole number, or above the cap (400 `invalid_goal_amount`, #701).
 */
function parseGoalInput(body: Record<string, unknown>): GoalInput | string {
  const rawKind = body.kind;
  if (typeof rawKind !== "string" || !KINDS.includes(rawKind as GoalKind)) {
    return `kind must be one of ${KINDS.join(", ")}`;
  }
  const kind = rawKind as GoalKind;
  const amountCents = body.amountCents;
  if (typeof amountCents !== "number") {
    return "amountCents is required";
  }
  assertGoalAmount(amountCents);
  const dueMonth = typeof body.dueMonth === "string" ? body.dueMonth : undefined;
  const every = typeof body.every === "number" ? body.every : undefined;

  if (kind === "monthly" || kind === "balance") {
    if (dueMonth !== undefined || every !== undefined) {
      return `${kind} accepts neither dueMonth nor every`;
    }
    return { kind, amountCents };
  }
  if (dueMonth === undefined) {
    return `${kind} requires dueMonth`;
  }
  if (kind === "by_date") {
    if (every !== undefined) {
      return "by_date accepts no every";
    }
    return { kind, amountCents, dueMonth };
  }
  // kind === "repeating"
  if (every === undefined || !INTERVALS.includes(every as RepeatInterval)) {
    return `repeating requires every to be one of ${INTERVALS.join(", ")}`;
  }
  return { kind, amountCents, dueMonth, every: every as RepeatInterval };
}

export function registerGoalsRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const writePreHandler = withWriteAccess(preHandler);
  const base = "/workspaces/:workspaceId/categories/:categoryId/goal";

  app.put(base, { preHandler: writePreHandler }, async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    let parsed: GoalInput | string;
    try {
      parsed = parseGoalInput((request.body ?? {}) as Record<string, unknown>);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
    if (typeof parsed === "string") {
      await reply.code(400).send({ error: `invalid goal: ${parsed}` });
      return;
    }

    const categories = await listCategories(request.db!, request.workspace!.id);
    if (!categories.some((c) => c.id === categoryId)) {
      await reply.code(400).send({ error: `categoryId "${categoryId}" does not name a category of this workspace` });
      return;
    }

    try {
      const goal = await upsertGoal(request.db!, request.workspace!.id, categoryId, parsed);
      await reply.code(200).send(goal);
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.get(base, { preHandler }, async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    const { month } = request.query as { month?: string };
    if (typeof month !== "string") {
      await reply.code(400).send({ error: "a month query parameter (YYYY-MM) is required" });
      return;
    }

    try {
      assertMonth(month);
      const progress = await getGoalProgress(request.db!, request.workspace!.id, categoryId, month);
      if (!progress) {
        await reply.code(404).send({ error: "no goal set for this category" });
        return;
      }
      return progress;
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  // Every goal of the workspace with its progress for one month (#682): the budget screen's own
  // single request, instead of one `GET .../categories/:categoryId/goal` per category.
  app.get("/workspaces/:workspaceId/goals", { preHandler }, async (request, reply) => {
    const { month } = request.query as { month?: string };
    if (typeof month !== "string") {
      await reply.code(400).send({ error: "a month query parameter (YYYY-MM) is required" });
      return;
    }

    try {
      assertMonth(month);
      return { goals: await listGoalProgress(request.db!, request.workspace!.id, month) };
    } catch (error) {
      if (await sendIfValidationError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  app.delete(base, { preHandler: writePreHandler }, async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    const removed = await deleteGoal(request.db!, request.workspace!.id, categoryId);
    if (!removed) {
      await reply.code(404).send({ error: "no goal set for this category" });
      return;
    }
    await reply.code(204).send();
  });
}
