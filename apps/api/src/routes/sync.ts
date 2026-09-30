import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler, requireWriteAccess } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { applyIncomingChange, type ApplyOutcome, type IncomingChange } from "../sync/apply.ts";

function parseChanges(body: Record<string, unknown>): IncomingChange[] | undefined {
  const raw = body.changes;
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const changes: IncomingChange[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return undefined;
    }
    const { id, entityId, fieldName, hlc, value } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof entityId !== "string" || typeof fieldName !== "string") {
      return undefined;
    }
    if (typeof hlc !== "object" || hlc === null) {
      return undefined;
    }
    const { physical, counter, deviceId } = hlc as Record<string, unknown>;
    if (typeof physical !== "number" || typeof counter !== "number" || typeof deviceId !== "string") {
      return undefined;
    }
    changes.push({ id, entityId, fieldName, hlc: { physical, counter, deviceId }, value });
  }
  return changes;
}

/**
 * The upload side of the field-level sync protocol (design.md, "Field-level change protocol";
 * #43): a device sends every change it queued while offline, in any order — `applyIncomingChange`
 * resolves each one by clock alone, so the result converges the same way regardless of that
 * order. The download side (a device fetching changes since its last clock) is `#44`.
 */
export function registerSyncRoutes(app: FastifyInstance, pool: DbPool): void {
  const preHandler = createWorkspaceMembershipPreHandler(pool);
  const writePreHandler = [preHandler, requireWriteAccess];

  app.post("/workspaces/:workspaceId/changes", { preHandler: writePreHandler }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const changes = parseChanges(body);
    if (!changes) {
      await reply.code(400).send({ error: "changes must be a non-empty array of valid change records" });
      return;
    }

    const results: { id: string; outcome: ApplyOutcome }[] = [];
    for (const change of changes) {
      const outcome = await applyIncomingChange(request.db!, request.workspace!.id, change);
      results.push({ id: change.id, outcome });
    }
    await reply.code(201).send({ results });
  });
}
