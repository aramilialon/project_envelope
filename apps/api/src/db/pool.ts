/**
 * The only place that imports "pg" directly (ADR 0005: node-postgres is the
 * project's single database driver). Everything else gets a pool from here.
 */
import pg from "pg";

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;

export function createPool(databaseUrl: string): DbPool {
  return new pg.Pool({ connectionString: databaseUrl });
}

/**
 * Runs `fn` in its own transaction on a dedicated client, with `app.user_id` (and any extra RLS
 * session variables, such as `app.workspace_id` when the row being written names its own id
 * before it exists) set for its duration. For the handful of repository functions with no
 * membership-scoped request to inherit a client from — registering a device token, listing a
 * user's own workspaces, creating a workspace itself. Rolls back and rethrows on any error,
 * always releasing the client back to the pool.
 */
export async function withUserScopedTransaction<T>(
  pool: DbPool,
  userId: string,
  fn: (client: DbClient) => Promise<T>,
  extraSessionVars: Readonly<Record<string, string>> = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [name, value] of Object.entries(extraSessionVars)) {
      await client.query("SELECT set_config($1, $2, true)", [name, value]);
    }
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
