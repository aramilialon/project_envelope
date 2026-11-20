import type { DbClient, DbPool } from "../db/pool.ts";

export interface PortfolioRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  /** Free text (#75): no fixed list of values. `null` when none was given. */
  readonly purpose: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
}

interface PortfolioRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly purpose: string | null;
  /** `node-postgres` parses `timestamptz` into a `Date`, not a string, despite the column's SQL type. */
  readonly archived_at: Date | null;
  readonly created_at: Date;
}

export interface PortfolioChanges {
  readonly name?: string;
  readonly purpose?: string | null;
  readonly archived?: boolean;
}

const PORTFOLIO_COLUMNS = "id, workspace_id, name, purpose, archived_at, created_at";

/** PostgreSQL's own error code for a unique constraint violation. */
const UNIQUE_VIOLATION = "23505";
const ACTIVE_NAME_INDEX = "portfolios_active_name_idx";

/**
 * Whether `error` is the race the application-level `isPortfolioNameTaken` check cannot close on
 * its own: a concurrent request creating, renaming or unarchiving a portfolio onto the same name
 * in between, caught by migration 0027's partial unique index.
 */
export function isPortfolioNameConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === ACTIVE_NAME_INDEX;
}

export async function createPortfolio(
  db: DbPool | DbClient,
  workspaceId: string,
  name: string,
  purpose: string | null,
): Promise<PortfolioRecord> {
  const { rows } = await db.query<PortfolioRow>(
    `INSERT INTO portfolios (workspace_id, name, purpose) VALUES ($1, $2, $3) RETURNING ${PORTFOLIO_COLUMNS}`,
    [workspaceId, name, purpose],
  );
  const portfolio = rows[0];
  if (!portfolio) {
    throw new Error("createPortfolio: INSERT ... RETURNING produced no row");
  }
  return toRecord(portfolio);
}

export async function getPortfolio(
  db: DbPool | DbClient,
  workspaceId: string,
  portfolioId: string,
): Promise<PortfolioRecord | undefined> {
  const { rows } = await db.query<PortfolioRow>(
    `SELECT ${PORTFOLIO_COLUMNS} FROM portfolios WHERE id = $1 AND workspace_id = $2`,
    [portfolioId, workspaceId],
  );
  return rows[0] ? toRecord(rows[0]) : undefined;
}

/** A workspace's portfolios by name; archived ones only when asked for. */
export async function listPortfolios(
  db: DbPool | DbClient,
  workspaceId: string,
  options: { readonly includeArchived?: boolean } = {},
): Promise<PortfolioRecord[]> {
  const { rows } = await db.query<PortfolioRow>(
    `SELECT ${PORTFOLIO_COLUMNS} FROM portfolios
     WHERE workspace_id = $1 AND ($2::boolean OR archived_at IS NULL)
     ORDER BY lower(name), created_at`,
    [workspaceId, options.includeArchived ?? false],
  );
  return rows.map(toRecord);
}

/**
 * Whether another non-archived portfolio of this workspace already has `name`, compared without
 * case or surrounding spaces — the same rule as category groups and categories (#397).
 */
export async function isPortfolioNameTaken(
  db: DbPool | DbClient,
  workspaceId: string,
  name: string,
  exceptPortfolioId?: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM portfolios
     WHERE workspace_id = $1 AND archived_at IS NULL AND lower(btrim(name)) = lower(btrim($2))
       AND ($3::uuid IS NULL OR id <> $3)
     LIMIT 1`,
    [workspaceId, name, exceptPortfolioId ?? null],
  );
  return rows.length > 0;
}

/**
 * Applies whichever of `changes` are given in one statement. Archiving keeps an already archived
 * portfolio's own `archived_at`; unarchiving clears it. Returns undefined if not found.
 */
export async function updatePortfolio(
  db: DbPool | DbClient,
  workspaceId: string,
  portfolioId: string,
  changes: PortfolioChanges,
): Promise<PortfolioRecord | undefined> {
  const { rows } = await db.query<PortfolioRow>(
    `UPDATE portfolios SET
       name = CASE WHEN $3::boolean THEN $4 ELSE name END,
       purpose = CASE WHEN $5::boolean THEN $6 ELSE purpose END,
       archived_at = CASE
         WHEN $7::boolean IS NULL THEN archived_at
         WHEN $7::boolean THEN COALESCE(archived_at, now())
         ELSE NULL
       END
     WHERE id = $1 AND workspace_id = $2
     RETURNING ${PORTFOLIO_COLUMNS}`,
    [
      portfolioId,
      workspaceId,
      changes.name !== undefined,
      changes.name ?? null,
      changes.purpose !== undefined,
      changes.purpose ?? null,
      changes.archived ?? null,
    ],
  );
  return rows[0] ? toRecord(rows[0]) : undefined;
}

/**
 * Deletes a portfolio outright. The `trades.portfolio_id` foreign key is `ON DELETE RESTRICT`
 * (#77): deleting a portfolio that still has trades throws a foreign key violation, which the route
 * answers as 409 `portfolio_has_trades` (it checks `portfolioHasTrades` first).
 * Returns whether a row was deleted.
 */
export async function deletePortfolio(db: DbPool | DbClient, workspaceId: string, portfolioId: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM portfolios WHERE id = $1 AND workspace_id = $2", [
    portfolioId,
    workspaceId,
  ]);
  return (rowCount ?? 0) > 0;
}

function toRecord(row: PortfolioRow): PortfolioRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    purpose: row.purpose,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}
