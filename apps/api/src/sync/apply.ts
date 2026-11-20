/**
 * Applies an incoming field-level change (design.md, "Field-level change protocol"; #43):
 * records it (idempotent on its own id within the workspace, #42, #513), then writes it onto the
 * real domain column it names — but only if its HLC is later than whatever this field's current
 * value already carries. "The server resolves conflicts by looking at the clock only... it never
 * needs to read the value" (design.md): the comparison is entirely between two HLCs, never the
 * values themselves.
 *
 * `field_name` names a real table.column ("transactions.memo"), but it comes from the device,
 * not from code we wrote — an allowlist keeps a malicious or buggy client from touching
 * anything beyond what fieldAppliers below has explicitly wired.
 */
import { compareHlc, MAX_FREE_TEXT_LENGTH, type Hlc } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";
import { workspaceRowExists, type WorkspaceTable } from "../db/workspace-row.ts";
import { isUuid } from "../ids.ts";
import { rederiveTradeCashLeg } from "../trades/repository.ts";
import { findRecordedChange, getLatestChange, recordChange, type RecordedChange } from "./repository.ts";

export interface IncomingChange {
  readonly id: string;
  readonly entityId: string;
  readonly fieldName: string;
  readonly hlc: Hlc;
  readonly value: unknown;
}

export type ApplyOutcome =
  | "applied"
  | "stale"
  | "unsupported_field"
  | "locked"
  | "trade_owned"
  | "invalid"
  | "not_found"
  | "id_conflict";

interface FieldApplier {
  /** The table whose row `entityId` must name, in the selected workspace, for the change to apply. */
  readonly table: WorkspaceTable;
  readonly apply: (db: DbPool | DbClient, workspaceId: string, entityId: string, value: unknown) => Promise<void>;
}

/**
 * Scoped to `transactions.memo`/`transactions.payee` for now (#43): enough to prove the
 * protocol converges end to end (the milestone's own smoke test, #46). Every other editable
 * field, and every other entity, is added here only once something actually needs to sync it.
 */
const FIELD_APPLIERS: Readonly<Record<string, FieldApplier>> = {
  "transactions.memo": {
    table: "transactions",
    apply: async (db, workspaceId, entityId, value) => {
      await db.query("UPDATE transactions SET memo = $1 WHERE id = $2 AND workspace_id = $3", [value, entityId, workspaceId]);
    },
  },
  "transactions.payee": {
    table: "transactions",
    apply: async (db, workspaceId, entityId, value) => {
      await db.query("UPDATE transactions SET payee = $1 WHERE id = $2 AND workspace_id = $3", [value, entityId, workspaceId]);
    },
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

/**
 * Whether `entityId` is a trade's cash leg, or a split of one. A field of `splits` names the split
 * row, a field of `transactions` the transaction.
 */
async function isTradeOwned(db: DbPool | DbClient, workspaceId: string, fieldName: string, entityId: string): Promise<boolean> {
  if (!isUuid(entityId)) {
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
 * a per-field concern. A field of `transactions` is locked by the transaction's own status; a
 * field of `trades` by its cash leg's (ADR 0012, #509): a reconciled leg locks its trade, and a
 * transfer's two legs go together, so the other leg's cash leg locks it too, as the trades API
 * refuses to edit either. Extend this once another entity gains a lock of its own.
 */
export async function isLocked(db: DbPool | DbClient, workspaceId: string, fieldName: string, entityId: string): Promise<boolean> {
  if (fieldName.startsWith("trades.")) {
    if (!isUuid(entityId)) {
      return false;
    }
    const { rows } = await db.query(
      `SELECT 1 FROM trades t
       JOIN transactions c ON c.workspace_id = t.workspace_id AND c.trade_id IN (t.id, t.transfer_trade_id)
       WHERE t.id = $1 AND t.workspace_id = $2 AND c.status = 'reconciled'`,
      [entityId, workspaceId],
    );
    return rows.length > 0;
  }
  if (!fieldName.startsWith("transactions.")) {
    return false;
  }
  const { rows } = await db.query<{ status: string }>("SELECT status FROM transactions WHERE id = $1 AND workspace_id = $2", [
    entityId,
    workspaceId,
  ]);
  return rows[0]?.status === "reconciled";
}

/** What a change already recorded under the same id answers (#513): its own outcome, if it is the same change. */
function outcomeOfRecorded(recorded: RecordedChange): ApplyOutcome {
  return recorded.sameChange ? recorded.outcome : "id_conflict";
}

/**
 * What an applied change sets in motion beyond its own column. A change to a field of a trade
 * re-derives the trade's cash leg (its amount, account and date; ADR 0012), which are never sync
 * fields themselves. No field of `trades` is wired into `FIELD_APPLIERS` yet, so this runs for
 * none today; it is here so that wiring one cannot leave the leg behind its trade.
 */
export async function afterApply(db: DbPool | DbClient, workspaceId: string, fieldName: string, entityId: string): Promise<void> {
  if (fieldName.startsWith("trades.")) {
    await rederiveTradeCashLeg(db, workspaceId, entityId);
  }
}

/**
 * Checked in this order, and only `applied` and `stale` are ever recorded:
 * - `invalid` when the change id or entity id is not a uuid (#513): it can name nothing.
 * - `trade_owned` for a field of a trade's cash leg that belongs to the trade
 *   (`TRADE_OWNED_FIELDS`), never recorded, for the same reason as `locked`.
 * - `unsupported_field` for anything not in `FIELD_APPLIERS` — recorded nowhere, since there is
 *   nowhere to apply it to; the caller reports it back to the device rather than silently
 *   dropping it. Both come before the change log is read: no change to such a field is ever
 *   recorded, so a resend could only ever get the same answer, and the value of a field nothing
 *   applies (any JSON at all) never reaches a query.
 * - A change id this workspace has already recorded answers what it answered then, so a retry
 *   gets its original outcome and nothing is applied again; `id_conflict` when that id was
 *   recorded for a different change (another entity, field, clock or value), which is refused.
 *   Change ids are scoped to the workspace: another workspace's ids are never looked at.
 * - `not_found` when the entity is not a row of the selected workspace (#513), whether it belongs
 *   to another workspace or to none, answered the same either way: there is nothing to apply it
 *   to, and recording it would hand the workspace's other devices a change to an entity they
 *   cannot have.
 * - `locked` is likewise never recorded: unlike a merely stale change (superseded, but a
 *   legitimate part of the entity's history), a rejected one never happened as far as this
 *   entity is concerned — if the device retries after the entity unlocks (#32), it can still
 *   apply then, undistorted by a change_log row from while it was refused.
 */
export async function applyIncomingChange(db: DbPool | DbClient, workspaceId: string, change: IncomingChange): Promise<ApplyOutcome> {
  if (!isUuid(change.id) || !isUuid(change.entityId)) {
    return "invalid";
  }
  if (TRADE_OWNED_FIELDS.has(change.fieldName) && (await isTradeOwned(db, workspaceId, change.fieldName, change.entityId))) {
    return "trade_owned";
  }
  // Own keys only: a field name such as "constructor" must not find an inherited property.
  const applier = Object.hasOwn(FIELD_APPLIERS, change.fieldName) ? FIELD_APPLIERS[change.fieldName] : undefined;
  if (!applier) {
    return "unsupported_field";
  }
  const recorded = await findRecordedChange(db, workspaceId, change);
  if (recorded) {
    return outcomeOfRecorded(recorded);
  }
  if (!(await workspaceRowExists(db, applier.table, workspaceId, change.entityId))) {
    return "not_found";
  }
  if (await isLocked(db, workspaceId, change.fieldName, change.entityId)) {
    return "locked";
  }

  const current = await getLatestChange(db, workspaceId, change.entityId, change.fieldName);
  const outcome = current && compareHlc(change.hlc, current.hlc) <= 0 ? "stale" : "applied";
  const inserted = await recordChange(db, {
    id: change.id,
    workspaceId,
    entityId: change.entityId,
    fieldName: change.fieldName,
    hlc: change.hlc,
    value: change.value,
    outcome,
  });
  if (!inserted) {
    // A concurrent request recorded a change under this id first, and has committed it.
    const winner = await findRecordedChange(db, workspaceId, change);
    return winner ? outcomeOfRecorded(winner) : "id_conflict";
  }

  if (outcome === "applied") {
    await applier.apply(db, workspaceId, change.entityId, change.value);
    await afterApply(db, workspaceId, change.fieldName, change.entityId);
  }
  return outcome;
}
