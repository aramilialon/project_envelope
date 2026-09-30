/**
 * The field-level change log (design.md, "Field-level change protocol"; #42): every write goes
 * through `recordChange`, idempotent on the change's own id — a repeated network retry of the
 * same change is a safe no-op, never a duplicate record ("sending it again never creates
 * duplicates", design.md).
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

export interface RecordChangeInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly entityId: string;
  readonly fieldName: string;
  readonly hlc: Hlc;
  readonly value: unknown;
}

export async function recordChange(db: DbPool | DbClient, input: RecordChangeInput): Promise<void> {
  await db.query(
    `INSERT INTO change_log (id, workspace_id, entity_id, field_name, hlc_physical, hlc_counter, device_id, value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
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
    ],
  );
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
