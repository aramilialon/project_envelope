import { randomUUID } from "node:crypto";

import { ValidationError } from "@envelope/core";

import type { DbClient, DbPool } from "../db/pool.ts";

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly baseCurrency: string;
  readonly timeZone: string;
}

export interface CreatedWorkspace {
  readonly id: string;
  readonly name: string;
  readonly role: "owner";
  readonly baseCurrency: string;
  readonly timeZone: string;
}

/** `Intl` itself is the validator: it throws on a currency/time zone it does not recognize, with no need for a hand-maintained list of every valid one. */
function assertValidCurrency(currency: string): void {
  try {
    new Intl.NumberFormat("en", { style: "currency", currency });
  } catch {
    throw new ValidationError("invalid_currency", `"${currency}" is not a known currency code`, { currency });
  }
}

function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new ValidationError("invalid_time_zone", `"${timeZone}" is not a known IANA time zone`, { timeZone });
  }
}

/**
 * Creates a workspace and its own first membership (the creator, as `owner`) in one transaction
 * (`#394`) — until now the only way this happened was a developer's own raw SQL. There is no
 * membership yet to scope a request to (`workspace-membership.ts`'s usual preHandler needs one
 * already), and `workspaces`' own RLS write check (`WITH CHECK (id = app_workspace_id())`,
 * migration 0008) requires `app.workspace_id` to already name the row being inserted — so the id
 * is generated here, client-side, before either insert, mirroring `listWorkspacesForUser`'s own
 * self-managed transaction (there is no single workspace to scope *that* one to either).
 */
export async function createWorkspace(pool: DbPool, userId: string, input: CreateWorkspaceInput): Promise<CreatedWorkspace> {
  assertValidCurrency(input.baseCurrency);
  assertValidTimeZone(input.timeZone);

  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [id]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, $2, $3, $4)", [
      id,
      input.name,
      input.baseCurrency,
      input.timeZone,
    ]);
    await client.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [userId, id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { id, name: input.name, role: "owner", baseCurrency: input.baseCurrency, timeZone: input.timeZone };
}

/**
 * Deletes a workspace outright. Every workspace-scoped table cascades straight from `workspaces`
 * itself (`ON DELETE CASCADE`, migration 0008's own doc comment, ADR 0006 — not a chain of
 * table-by-table cascades), so removing this one row is enough. The route's own preHandler
 * (`requireOwnerRole`) is what actually restricts this to the owner; this function does not
 * check the caller's own role again.
 */
export async function deleteWorkspace(db: DbPool | DbClient, workspaceId: string): Promise<void> {
  await db.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
}
