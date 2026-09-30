/**
 * Applies an incoming field-level change (design.md, "Field-level change protocol"; #43):
 * records it (idempotent on its own id, #42), then writes it onto the real domain column it
 * names — but only if its HLC is later than whatever this field's current value already
 * carries. "The server resolves conflicts by looking at the clock only... it never needs to
 * read the value" (design.md): the comparison is entirely between two HLCs, never the values
 * themselves.
 *
 * `field_name` names a real table.column ("transactions.memo"), but it comes from the device,
 * not from code we wrote — an allowlist keeps a malicious or buggy client from touching
 * anything beyond what fieldAppliers below has explicitly wired.
 */
import { compareHlc, type Hlc } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";
import { getLatestChange, recordChange } from "./repository.ts";

export interface IncomingChange {
  readonly id: string;
  readonly entityId: string;
  readonly fieldName: string;
  readonly hlc: Hlc;
  readonly value: unknown;
}

export type ApplyOutcome = "applied" | "stale" | "unsupported_field";

type FieldApplier = (db: DbPool | DbClient, workspaceId: string, entityId: string, value: unknown) => Promise<void>;

/**
 * Scoped to `transactions.memo`/`transactions.payee` for now (#43): enough to prove the
 * protocol converges end to end (the milestone's own smoke test, #46). Every other editable
 * field, and every other entity, is added here only once something actually needs to sync it.
 */
const FIELD_APPLIERS: Readonly<Record<string, FieldApplier>> = {
  "transactions.memo": async (db, workspaceId, entityId, value) => {
    await db.query("UPDATE transactions SET memo = $1 WHERE id = $2 AND workspace_id = $3", [value, entityId, workspaceId]);
  },
  "transactions.payee": async (db, workspaceId, entityId, value) => {
    await db.query("UPDATE transactions SET payee = $1 WHERE id = $2 AND workspace_id = $3", [value, entityId, workspaceId]);
  },
};

/**
 * `unsupported_field` for anything not in `FIELD_APPLIERS` — recorded nowhere, since there is
 * nowhere to apply it to; the caller reports it back to the device rather than silently
 * dropping it. The reconciled-transaction "locked" flag (design.md) is not enforced here yet:
 * that is #45's own job, layered on top of this same function.
 */
export async function applyIncomingChange(db: DbPool | DbClient, workspaceId: string, change: IncomingChange): Promise<ApplyOutcome> {
  const applier = FIELD_APPLIERS[change.fieldName];
  if (!applier) {
    return "unsupported_field";
  }

  const current = await getLatestChange(db, workspaceId, change.entityId, change.fieldName);
  await recordChange(db, {
    id: change.id,
    workspaceId,
    entityId: change.entityId,
    fieldName: change.fieldName,
    hlc: change.hlc,
    value: change.value,
  });

  if (current && compareHlc(change.hlc, current.hlc) <= 0) {
    return "stale";
  }

  await applier(db, workspaceId, change.entityId, change.value);
  return "applied";
}
