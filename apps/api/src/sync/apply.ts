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
import { compareHlc, MAX_FREE_TEXT_LENGTH, type Hlc } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";
import { getLatestChange, recordChange } from "./repository.ts";

export interface IncomingChange {
  readonly id: string;
  readonly entityId: string;
  readonly fieldName: string;
  readonly hlc: Hlc;
  readonly value: unknown;
}

export type ApplyOutcome = "applied" | "stale" | "unsupported_field" | "locked" | "trade_owned";

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
 * The length limit (#507) of every wired-up text field, so a change can no more store an
 * over-long value than the route that edits the same field directly. The upload route checks
 * every change against it before applying any of them.
 */
export const SYNC_TEXT_FIELD_LIMITS: Readonly<Record<string, number>> = {
  "transactions.memo": MAX_FREE_TEXT_LENGTH,
  "transactions.payee": MAX_FREE_TEXT_LENGTH,
};

/**
 * The fields of a trade's cash leg that belong to the trade (ADR 0012): its account, its date and
 * its amount (a split's amount, and its category, which a leg never has). They are never sync
 * fields: a change to one of them on a trade-owned transaction is refused with `trade_owned`,
 * checked before the allowlist, so wiring one of these fields up later for ordinary transactions
 * cannot open a way to change a leg behind its trade's back. A change to the trade is a change to
 * the trade, and the server rewrites the leg.
 */
export const TRADE_OWNED_FIELDS: ReadonlySet<string> = new Set([
  "transactions.account_id",
  "transactions.occurred_at",
  "transactions.amount_cents",
  "splits.amount_cents",
  "splits.category_id",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `entityId` is a trade's cash leg, or a split of one. A field of `splits` names the split
 * row, a field of `transactions` the transaction.
 */
async function isTradeOwned(db: DbPool | DbClient, workspaceId: string, fieldName: string, entityId: string): Promise<boolean> {
  if (!UUID_PATTERN.test(entityId)) {
    return false;
  }
  const { rows } = await db.query(
    fieldName.startsWith("splits.")
      ? `SELECT 1 FROM splits s JOIN transactions t ON t.id = s.transaction_id AND t.workspace_id = s.workspace_id
         WHERE s.id = $1 AND s.workspace_id = $2 AND t.trade_id IS NOT NULL`
      : "SELECT 1 FROM transactions WHERE id = $1 AND workspace_id = $2 AND trade_id IS NOT NULL",
    [entityId, workspaceId],
  );
  return rows.length > 0;
}

/**
 * "Reconciled transactions carry a plaintext 'locked' flag: the server rejects later changes"
 * (design.md) — a rule of the protocol itself, checked before clock resolution even runs, not
 * a per-field concern. Every field currently wired up belongs to `transactions`; extend this
 * once another entity gains a lock of its own.
 */
async function isLocked(db: DbPool | DbClient, workspaceId: string, fieldName: string, entityId: string): Promise<boolean> {
  if (!fieldName.startsWith("transactions.")) {
    return false;
  }
  const { rows } = await db.query<{ status: string }>("SELECT status FROM transactions WHERE id = $1 AND workspace_id = $2", [
    entityId,
    workspaceId,
  ]);
  return rows[0]?.status === "reconciled";
}

/**
 * `trade_owned` for a field of a trade's cash leg that belongs to the trade (`TRADE_OWNED_FIELDS`),
 * never recorded either, for the same reason as `locked`.
 * `unsupported_field` for anything not in `FIELD_APPLIERS` — recorded nowhere, since there is
 * nowhere to apply it to; the caller reports it back to the device rather than silently
 * dropping it. `locked` is likewise never recorded: unlike a merely stale change (superseded,
 * but a legitimate part of the entity's history), a rejected one never happened as far as this
 * entity is concerned — if the device retries after the entity unlocks (#32), it can still
 * apply then, undistorted by a change_log row from while it was refused.
 */
export async function applyIncomingChange(db: DbPool | DbClient, workspaceId: string, change: IncomingChange): Promise<ApplyOutcome> {
  if (TRADE_OWNED_FIELDS.has(change.fieldName) && (await isTradeOwned(db, workspaceId, change.fieldName, change.entityId))) {
    return "trade_owned";
  }
  const applier = FIELD_APPLIERS[change.fieldName];
  if (!applier) {
    return "unsupported_field";
  }
  if (await isLocked(db, workspaceId, change.fieldName, change.entityId)) {
    return "locked";
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
