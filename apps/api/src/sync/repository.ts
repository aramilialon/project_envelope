/**
 * The field-level change log (design.md, "Field-level change protocol"; #42): every write goes
 * through `recordChange`, idempotent on the change's own id within its workspace — a repeated
 * network retry of the same change is a safe no-op, never a duplicate record ("sending it again
 * never creates duplicates", design.md). The key is `(workspace_id, id)` (#513): the same id sent
 * to another workspace is an unrelated change there, never a collision with this one.
 */
import type { Hlc } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";

export interface ChangeRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly entityId: string;
  readonly fieldName: string;
  readonly hlc: Hlc;
  readonly value: unknown;
  readonly receivedAt: string;
}

interface ChangeLogRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly entity_id: string;
  readonly field_name: string;
  readonly hlc_physical: string;
  readonly hlc_counter: number;
  readonly device_id: string;
  readonly value: unknown;
  readonly received_at: string;
}

function toChangeRecord(row: ChangeLogRow): ChangeRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    entityId: row.entity_id,
    fieldName: row.field_name,
    hlc: { physical: Number(row.hlc_physical), counter: row.hlc_counter, deviceId: row.device_id },
    value: row.value,
    receivedAt: row.received_at,
  };
}

/** What the upload answered when a recorded change was first received: only accepted changes are recorded. */
export type RecordedOutcome = "applied" | "stale";

export interface RecordChangeInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly entityId: string;
  readonly fieldName: string;
  readonly hlc: Hlc;
  readonly value: unknown;
  readonly outcome: RecordedOutcome;
}

/**
 * Records a change, unless this workspace already has one with the same id. Returns whether it
 * inserted a row: false means a change with this id was already recorded (a retry, or a
 * concurrent request with the same change that committed first), and the caller must not apply
 * this one again; `findRecordedChange` says what that earlier one was.
 */
export async function recordChange(db: DbPool | DbClient, input: RecordChangeInput): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO change_log (id, workspace_id, entity_id, field_name, hlc_physical, hlc_counter, device_id, value, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (workspace_id, id) DO NOTHING`,
    [
      input.id,
      input.workspaceId,
      input.entityId,
      input.fieldName,
      input.hlc.physical,
      input.hlc.counter,
      input.hlc.deviceId,
      // node-postgres only auto-encodes a plain object as JSON for a jsonb column; a bare
      // string value (as opposed to one already wrapped in an object) would otherwise be sent
      // as raw, unquoted text and rejected by Postgres's own JSON parser.
      JSON.stringify(input.value ?? null),
      input.outcome,
    ],
  );
  return rowCount === 1;
}

/** A change already recorded under an id, and whether it is the very change being sent again. */
export interface RecordedChange {
  readonly outcome: RecordedOutcome;
  /** Whether the recorded change has the same entity, field, clock and value as the one compared. */
  readonly sameChange: boolean;
}

/**
 * The change this workspace already recorded under `change.id`, if any (#513), compared with
 * `change`: a retry sends the very same change again, while a different change under a used id is
 * a client error. Only this workspace's rows are looked at, so another workspace's ids never
 * show.
 */
export async function findRecordedChange(
  db: DbPool | DbClient,
  workspaceId: string,
  change: Omit<RecordChangeInput, "workspaceId" | "outcome">,
): Promise<RecordedChange | undefined> {
  const { rows } = await db.query<{ outcome: RecordedOutcome; same_change: boolean }>(
    `SELECT outcome,
            (entity_id = $3 AND field_name = $4 AND hlc_physical = $5 AND hlc_counter = $6 AND device_id = $7
             AND value IS NOT DISTINCT FROM $8::jsonb) AS same_change
     FROM change_log
     WHERE workspace_id = $1 AND id = $2`,
    [
      workspaceId,
      change.id,
      change.entityId,
      change.fieldName,
      change.hlc.physical,
      change.hlc.counter,
      change.hlc.deviceId,
      JSON.stringify(change.value ?? null),
    ],
  );
  const row = rows[0];
  return row ? { outcome: row.outcome, sameChange: row.same_change } : undefined;
}

/** The most recent change for one entity's field, if any — what an incoming change's HLC must beat to win (#43). */
export async function getLatestChange(
  db: DbPool | DbClient,
  workspaceId: string,
  entityId: string,
  fieldName: string,
): Promise<ChangeRecord | undefined> {
  const { rows } = await db.query<ChangeLogRow>(
    `SELECT id, workspace_id, entity_id, field_name, hlc_physical, hlc_counter, device_id, value, received_at
     FROM change_log
     WHERE workspace_id = $1 AND entity_id = $2 AND field_name = $3
     ORDER BY hlc_physical DESC, hlc_counter DESC, device_id DESC
     LIMIT 1`,
    [workspaceId, entityId, fieldName],
  );
  const row = rows[0];
  return row ? toChangeRecord(row) : undefined;
}

/**
 * Every change later than `since` (design.md: "each device downloads the changes that arrived
 * after the last clock value it has seen", #44) — every change at all when `since` is omitted,
 * for a device syncing for the first time. Ordered the same way `compareHlc` would: the row
 * comparison `(hlc_physical, hlc_counter, device_id) > (...)` is exactly that ordering in SQL.
 */
export async function listChangesSince(db: DbPool | DbClient, workspaceId: string, since?: Hlc): Promise<ChangeRecord[]> {
  const { rows } = await db.query<ChangeLogRow>(
    since
      ? `SELECT id, workspace_id, entity_id, field_name, hlc_physical, hlc_counter, device_id, value, received_at
         FROM change_log
         WHERE workspace_id = $1 AND (hlc_physical, hlc_counter, device_id) > ($2, $3, $4)
         ORDER BY hlc_physical, hlc_counter, device_id`
      : `SELECT id, workspace_id, entity_id, field_name, hlc_physical, hlc_counter, device_id, value, received_at
         FROM change_log
         WHERE workspace_id = $1
         ORDER BY hlc_physical, hlc_counter, device_id`,
    since ? [workspaceId, since.physical, since.counter, since.deviceId] : [workspaceId],
  );
  return rows.map(toChangeRecord);
}
