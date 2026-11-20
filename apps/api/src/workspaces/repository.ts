import { randomUUID } from "node:crypto";

import { ValidationError } from "@envelope/core";

import { withUserScopedTransaction, type DbClient, type DbPool } from "../db/pool.ts";

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
  /** Always null on creation; set later by the owner (#508). */
  readonly taxCountry: null;
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
  await withUserScopedTransaction(
    pool,
    userId,
    async (client) => {
      await client.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, $2, $3, $4)", [
        id,
        input.name,
        input.baseCurrency,
        input.timeZone,
      ]);
      await client.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [userId, id]);
    },
    { "app.workspace_id": id },
  );
  return { id, name: input.name, role: "owner", baseCurrency: input.baseCurrency, timeZone: input.timeZone, taxCountry: null };
}

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

/** An ISO 3166-1 alpha-2 code `Intl` knows as a region, the same way the currency and time zone are checked. */
function assertValidTaxCountry(taxCountry: string): void {
  if (!/^[A-Z]{2}$/.test(taxCountry) || REGION_NAMES.of(taxCountry) === undefined) {
    throw new ValidationError("invalid_tax_country", `"${taxCountry}" is not an ISO 3166-1 alpha-2 country code`, {
      taxCountry,
    });
  }
}

export interface WorkspaceSettings {
  readonly id: string;
  readonly name: string;
  readonly baseCurrency: string;
  readonly timeZone: string;
  readonly taxCountry: string | null;
}

/**
 * Sets the workspace's tax country (#508), or clears it with null. The route restricts this to
 * the owner (`requireOwnerRole`). Brokerage accounts created before the change keep whatever
 * regime they have, possibly none: setting `IT` does not ask for one retroactively.
 *
 * @throws ValidationError "invalid_tax_country" for a code that is not a known ISO 3166-1 alpha-2 region.
 */
export async function setWorkspaceTaxCountry(
  db: DbPool | DbClient,
  workspaceId: string,
  taxCountry: string | null,
): Promise<WorkspaceSettings | undefined> {
  if (taxCountry !== null) {
    assertValidTaxCountry(taxCountry);
  }
  const { rows } = await db.query<{ id: string; name: string; base_currency: string; time_zone: string; tax_country: string | null }>(
    `UPDATE workspaces SET tax_country = $2 WHERE id = $1
     RETURNING id, name, base_currency, time_zone, tax_country`,
    [workspaceId, taxCountry],
  );
  const row = rows[0];
  return row
    ? { id: row.id, name: row.name, baseCurrency: row.base_currency, timeZone: row.time_zone, taxCountry: row.tax_country }
    : undefined;
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
