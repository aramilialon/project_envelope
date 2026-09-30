import type { Hlc } from "@envelope/core";
import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler, requireWriteAccess } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { applyIncomingChange, type ApplyOutcome, type IncomingChange } from "../sync/apply.ts";
import { listChangesSince } from "../sync/repository.ts";

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
 * `sincePhysical`/`sinceCounter`/`sinceDeviceId` name the last HLC a device has seen — all
 * three or none (a partial HLC names no real clock value). None at all means a device syncing
 * for the first time, which downloads everything.
 */
function parseSince(query: Record<string, unknown>): Hlc | undefined | "invalid" {
  const { sincePhysical, sinceCounter, sinceDeviceId } = query;
  if (sincePhysical === undefined && sinceCounter === undefined && sinceDeviceId === undefined) {
    return undefined;
  }
  if (typeof sincePhysical !== "string" || typeof sinceCounter !== "string" || typeof sinceDeviceId !== "string") {
    return "invalid";
  }
  const physical = Number(sincePhysical);
  const counter = Number(sinceCounter);
  if (!Number.isFinite(physical) || !Number.isFinite(counter)) {
    return "invalid";
  }
  return { physical, counter, deviceId: sinceDeviceId };
}

/**
 * The field-level sync protocol (design.md, "Field-level change protocol"):
 * - Upload (#43): a device sends every change it queued while offline, in any order —
 *   `applyIncomingChange` resolves each one by clock alone, so the result converges the same
 *   way regardless of that order.
 * - Download (#44): a device fetches every change later than the last one it has seen.
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

  app.get("/workspaces/:workspaceId/changes", { preHandler }, async (request, reply) => {
    const since = parseSince(request.query as Record<string, unknown>);
    if (since === "invalid") {
      await reply.code(400).send({ error: "sincePhysical, sinceCounter and sinceDeviceId must be given together, or not at all" });
      return;
    }

    const changes = await listChangesSince(request.db!, request.workspace!.id, since);
    return { changes: changes.map((c) => ({ id: c.id, entityId: c.entityId, fieldName: c.fieldName, hlc: c.hlc, value: c.value })) };
  });
}
