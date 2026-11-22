/**
 * The SQL of idempotent creates (#559, ADR 0020; ADR 0005: no SQL in the route module): claiming
 * an `Idempotency-Key`, storing the reply it got, and removing expired keys.
 *
 * Lock order: a request claims its key first, then its assignment batch (assignments/repository.ts,
 * `claimAssignmentBatch`), and only then takes any other lock: the category-month locks (#704) and
 * the transactions it writes `FOR UPDATE` in id order (#554), and the closed-account trigger's
 * `FOR KEY SHARE` on accounts. A duplicate in flight waits on the first request's uncommitted key
 * while holding nothing else, so it cannot deadlock; once the first commits it reads the stored
 * reply, and if the first rolls back it claims the key itself.
 */
import type { DbClient } from "../db/pool.ts";
import { RequestInProgressError } from "../errors.ts";

/** How long a key is kept: at least this, at most this plus the sweep's hour (design.md, "Security, privacy and GDPR"). */
export const IDEMPOTENCY_KEY_LIFETIME = "24 hours";

/**
 * How long a claim waits for a request in flight that holds the same key or batch id before it
 * answers 409 `request_in_progress` with `Retry-After`. The wait is only ever for a duplicate.
 */
export const CLAIM_LOCK_TIMEOUT = "5s";

const LOCK_NOT_AVAILABLE = "55P03";

export interface IdempotencyKeyClaim {
  readonly workspaceId: string;
  readonly key: string;
  readonly userId: string;
  /** The route pattern, for diagnostics. */
  readonly operation: string;
  /** sha256 of the request (idempotency/fingerprint.ts), 32 bytes. */
  readonly requestHash: Buffer;
}

export type IdempotencyClaimOutcome =
  | { readonly kind: "claimed" }
  | { readonly kind: "replay"; readonly status: number; readonly body: unknown }
  | { readonly kind: "conflict" };

/**
 * Runs `claim` (a single INSERT that may wait on another transaction's uncommitted row) under
 * `CLAIM_LOCK_TIMEOUT`, then puts back the lock_timeout the transaction had before, so the rest of
 * the request waits on its locks as it always did, whatever set that value. A timeout aborts the
 * transaction; the 409 it maps to rolls it back.
 *
 * `SET LOCAL` with a quoted literal, not `set_config`: the system-job allowlist test
 * (db/system-job-allowlist.test.ts) only lets a `set_config` name an `app.*` setting, and `SET`
 * takes no bind parameters.
 *
 * @throws RequestInProgressError when the wait runs out.
 */
export async function withClaimLockTimeout<T>(db: DbClient, claim: () => Promise<T>): Promise<T> {
  const { rows } = await db.query<{ lock_timeout: string }>("SELECT current_setting('lock_timeout') AS lock_timeout");
  const saved = rows[0]!.lock_timeout;
  await db.query(`SET LOCAL lock_timeout = '${CLAIM_LOCK_TIMEOUT}'`);
  let result: T;
  try {
    result = await claim();
  } catch (error) {
    if ((error as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      throw new RequestInProgressError();
    }
    throw error;
  }
  await db.query(`SET LOCAL lock_timeout = ${db.escapeLiteral(saved)}`);
  return result;
}

/**
 * Claims `input.key` in its workspace, the first lock the request takes:
 * - `claimed`: the key is new (or had expired, and its old row is deleted): the caller runs the
 *   request and must store its reply with `storeIdempotentReply` before sending it.
 * - `replay`: the key was used for the same request, which succeeded: send its stored reply.
 * - `conflict`: the key was used for a different request (body, route, path, member).
 *
 * A request in flight with the same key makes this wait until it commits or rolls back.
 *
 * @throws RequestInProgressError when that wait is longer than `CLAIM_LOCK_TIMEOUT`.
 * @throws Error when the stored row has no reply: the deferred trigger of migration 0039 never lets
 *   one commit, so this is a bug, answered 500, never replayed as an empty success.
 */
export async function claimIdempotencyKey(db: DbClient, input: IdempotencyKeyClaim): Promise<IdempotencyClaimOutcome> {
  return withClaimLockTimeout(db, async () => {
    // An expired key counts as new. Rows of other transactions still in flight are not visible
    // here, so this never waits; the INSERT below does.
    await db.query(
      `DELETE FROM idempotency_keys
       WHERE workspace_id = $1 AND key = $2 AND created_at < now() - $3::interval`,
      [input.workspaceId, input.key, IDEMPOTENCY_KEY_LIFETIME],
    );
    const inserted = await db.query(
      `INSERT INTO idempotency_keys (workspace_id, key, user_id, operation, request_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, key) DO NOTHING
       RETURNING key`,
      [input.workspaceId, input.key, input.userId, input.operation, input.requestHash],
    );
    if (inserted.rows.length > 0) {
      return { kind: "claimed" } as const;
    }

    // READ COMMITTED: this statement sees the row the INSERT above waited for, once committed.
    const { rows } = await db.query<{ request_hash: Buffer; response_status: number | null; response_body: unknown }>(
      `SELECT request_hash, response_status, response_body FROM idempotency_keys
       WHERE workspace_id = $1 AND key = $2`,
      [input.workspaceId, input.key],
    );
    const stored = rows[0];
    if (!stored) {
      // Deleted between the INSERT and this SELECT (the sweep, or an expired claim that then rolled
      // back): the request cannot tell what happened, and a retry claims the key afresh.
      throw new RequestInProgressError();
    }
    if (!stored.request_hash.equals(input.requestHash)) {
      return { kind: "conflict" } as const;
    }
    if (stored.response_status === null) {
      throw new Error("an idempotency key was committed without its reply");
    }
    return { kind: "replay", status: stored.response_status, body: stored.response_body } as const;
  });
}

/** Stores the reply of a request whose key `claimIdempotencyKey` claimed, in the same transaction. */
export async function storeIdempotentReply(
  db: DbClient,
  workspaceId: string,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE idempotency_keys SET response_status = $3, response_body = $4::jsonb
     WHERE workspace_id = $1 AND key = $2 AND response_status IS NULL`,
    [workspaceId, key, status, JSON.stringify(body ?? null)],
  );
  if (rowCount !== 1) {
    throw new Error("no claimed idempotency key to store the reply on");
  }
}

/**
 * Deletes the workspace's keys older than `IDEMPOTENCY_KEY_LIFETIME`, under the workspace's own
 * policy (`app.workspace_id` set by the caller). Returns how many it deleted.
 */
export async function deleteExpiredIdempotencyKeys(db: DbClient, workspaceId: string): Promise<number> {
  const { rowCount } = await db.query(
    "DELETE FROM idempotency_keys WHERE workspace_id = $1 AND created_at < now() - $2::interval",
    [workspaceId, IDEMPOTENCY_KEY_LIFETIME],
  );
  return rowCount ?? 0;
}
