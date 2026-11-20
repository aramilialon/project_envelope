import type { Hlc } from "@envelope/core";
import type { FastifyInstance } from "fastify";

import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import type { DbPool } from "../db/pool.ts";
import { sendIfTextTooLong, type TextFieldCheck } from "../errors.ts";
import { isUuid } from "../ids.ts";
import { applyIncomingChange, SYNC_TEXT_FIELD_LIMITS, type ApplyOutcome, type IncomingChange } from "../sync/apply.ts";
import { listChangesSince } from "../sync/repository.ts";

/** One change of an upload, and whether its ids are well formed. */
interface ParsedChange {
  readonly change: IncomingChange;
  /** False when `id` or `entityId` is not a uuid: the change gets its own `invalid` result (#513). */
  readonly wellFormed: boolean;
}

/**
 * Undefined when the body's shape is wrong (not an array of change records with string ids and a
 * numeric clock), which refuses the whole upload. A change whose `id` or `entityId` is a string
 * but not a uuid is kept, marked, so it alone is answered `invalid` and the rest still apply.
 */
function parseChanges(body: Record<string, unknown>): ParsedChange[] | undefined {
  const raw = body.changes;
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const changes: ParsedChange[] = [];
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
    changes.push({
      change: { id, entityId, fieldName, hlc: { physical, counter, deviceId }, value },
      wellFormed: isUuid(id) && isUuid(entityId),
    });
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
  const writePreHandler = withWriteAccess(preHandler);

  app.post("/workspaces/:workspaceId/changes", { preHandler: writePreHandler }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const parsed = parseChanges(body);
    if (!parsed) {
      await reply.code(400).send({ error: "changes must be a non-empty array of valid change records" });
      return;
    }
    const changes = parsed.map((item) => item.change);
    // A text field takes a string or null, nothing else: an object or array would otherwise skip
    // the length check below and be stored as its JSON text, of any size (#507).
    const textChanges = changes.filter((change) => SYNC_TEXT_FIELD_LIMITS[change.fieldName] !== undefined);
    const nonText = textChanges.find((change) => change.value !== null && typeof change.value !== "string");
    if (nonText) {
      await reply.code(400).send({ error: `invalid change: ${nonText.fieldName} takes a string or null` });
      return;
    }
    const textChecks = textChanges
      .map((change): TextFieldCheck => [change.fieldName, change.value, SYNC_TEXT_FIELD_LIMITS[change.fieldName]!]);
    if (await sendIfTextTooLong(reply, textChecks)) {
      return;
    }

    const results: { id: string; outcome: ApplyOutcome }[] = [];
    for (const { change, wellFormed } of parsed) {
      const outcome = wellFormed ? await applyIncomingChange(request.db!, request.workspace!.id, change) : "invalid";
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
