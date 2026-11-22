/**
 * Claiming an `Idempotency-Key` and a client batch id (#559, ADR 0020), on two connections at once,
 * as envelope_app; isolation between workspaces; and the hourly sweep of expired keys.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { claimAssignmentBatch, createAssignmentBatch } from "../assignments/repository.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbClient, type DbPool } from "../db/pool.ts";
import { RequestInProgressError } from "../errors.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "../test-helpers/isolated-database.ts";
import { valueFingerprint } from "./fingerprint.ts";
import { claimIdempotencyKey, storeIdempotentReply, type IdempotencyClaimOutcome } from "./repository.ts";
import { createIdempotencyKeysSweepHandler, sweepWorkspaceIdempotencyKeys } from "./sweep-job.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

const hash = (text: string): Buffer => valueFingerprint([text]);

describe("idempotency keys and assignment batches, as envelope_app (#559)", () => {
  let superuserPool: DbPool;
  let appPool: DbPool;
  let workspaceA: string;
  let workspaceB: string;
  let userId: string;
  let categoryA: string;

  let database: IsolatedDatabase | undefined;

  // A database of its own (#519, #638): the sweep job deletes expired keys in every workspace there is.
  before(async () => {
    database = await createIsolatedDatabase(databaseUrl);
    superuserPool = createPool(database.databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(database.databaseUrl));

    workspaceA = randomUUID();
    workspaceB = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Keys A', 'EUR', 'UTC'), ($2, 'Keys B', 'EUR', 'UTC')",
      [workspaceA, workspaceB],
    );
    const user = await superuserPool.query<{ id: string }>("INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id", [
      randomUUID(),
      `${randomUUID()}@example.com`,
    ]);
    userId = user.rows[0]!.id;
    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceA],
    );
    const category = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Rent', 1) RETURNING id",
      [workspaceA, group.rows[0]!.id],
    );
    categoryA = category.rows[0]!.id;
  });

  after(async () => {
    try {
      await appPool?.end();
      await superuserPool?.end();
    } finally {
      await database?.drop();
    }
  });

  /** A connection of envelope_app in an open transaction on `workspaceId`, as a request has. */
  async function begin(workspaceId: string): Promise<DbClient> {
    const client = await appPool.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    return client;
  }

  async function inWorkspace<T>(workspaceId: string, work: (client: DbClient) => Promise<T>): Promise<T> {
    const client = await begin(workspaceId);
    try {
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const keyInput = (key: string, requestHash: Buffer, workspaceId = workspaceA) => ({
    workspaceId,
    key,
    userId,
    operation: "test",
    requestHash,
  });

  /**
   * A claims in an open transaction; B, on another connection, claims the same id and waits on A's
   * uncommitted row (B's pid is read before it starts, lesson #554). Then A finishes as `finishA` says.
   */
  async function race<T>(
    claimA: (client: DbClient) => Promise<unknown>,
    claimB: (client: DbClient) => Promise<T>,
    finishA: "COMMIT" | "ROLLBACK",
  ): Promise<T> {
    const clientA = await begin(workspaceA);
    const clientB = await begin(workspaceA);
    try {
      const { rows } = await clientB.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pidB = rows[0]!.pid;
      await claimA(clientA);
      let settledB = false;
      const pendingB = claimB(clientB).finally(() => {
        settledB = true;
      });
      for (;;) {
        const waiting = await superuserPool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pidB]);
        if (waiting.rows.length > 0) {
          break;
        }
        assert.equal(settledB, false, "B's claim was expected to wait on A's open transaction");
        await new Promise((resolve) => setImmediate(resolve));
      }
      await clientA.query(finishA);
      const outcome = await pendingB;
      await clientB.query("COMMIT");
      return outcome;
    } finally {
      clientA.release();
      clientB.release();
    }
  }

  describe("an Idempotency-Key claimed by two requests at once", () => {
    it("makes the second wait, then replay the first's reply once it commits", async () => {
      const key = randomUUID();
      const outcome = await race(
        async (client) => {
          assert.deepEqual(await claimIdempotencyKey(client, keyInput(key, hash("same"))), { kind: "claimed" });
          await storeIdempotentReply(client, workspaceA, key, 201, { id: "first" });
        },
        (client) => claimIdempotencyKey(client, keyInput(key, hash("same"))),
        "COMMIT",
      );
      assert.deepEqual(outcome, { kind: "replay", status: 201, body: { id: "first" } } satisfies IdempotencyClaimOutcome);
      const { rows } = await superuserPool.query("SELECT 1 FROM idempotency_keys WHERE key = $1", [key]);
      assert.equal(rows.length, 1);
    });

    it("makes the second wait, then answer conflict when its request differs", async () => {
      const key = randomUUID();
      const outcome = await race(
        async (client) => {
          await claimIdempotencyKey(client, keyInput(key, hash("first")));
          await storeIdempotentReply(client, workspaceA, key, 201, { id: "first" });
        },
        (client) => claimIdempotencyKey(client, keyInput(key, hash("second"))),
        "COMMIT",
      );
      assert.deepEqual(outcome, { kind: "conflict" });
    });

    it("lets the second claim the key itself when the first rolls back", async () => {
      const key = randomUUID();
      const outcome = await race(
        async (client) => {
          await claimIdempotencyKey(client, keyInput(key, hash("same")));
        },
        async (client) => {
          const claimed = await claimIdempotencyKey(client, keyInput(key, hash("same")));
          await storeIdempotentReply(client, workspaceA, key, 201, { id: "second" });
          return claimed;
        },
        "ROLLBACK",
      );
      assert.deepEqual(outcome, { kind: "claimed" });
      const { rows } = await superuserPool.query<{ response_body: unknown }>("SELECT response_body FROM idempotency_keys WHERE key = $1", [key]);
      assert.deepEqual(rows, [{ response_body: { id: "second" } }]);
    });

    it("gives up after the claim's lock timeout with request_in_progress, holding nothing", async () => {
      const key = randomUUID();
      const holder = await begin(workspaceA);
      const waiter = await begin(workspaceA);
      try {
        await claimIdempotencyKey(holder, keyInput(key, hash("same")));
        const started = Date.now();
        await assert.rejects(() => claimIdempotencyKey(waiter, keyInput(key, hash("same"))), RequestInProgressError);
        assert.ok(Date.now() - started >= 4_000, "waited for the claim's lock timeout");
      } finally {
        await waiter.query("ROLLBACK");
        await holder.query("ROLLBACK");
        waiter.release();
        holder.release();
      }
    });

    it("puts the transaction's lock timeout back after the claim", async () => {
      const client = await begin(workspaceA);
      try {
        await claimIdempotencyKey(client, keyInput(randomUUID(), hash("timeout")));
        const { rows } = await client.query<{ lock_timeout: string }>("SHOW lock_timeout");
        assert.equal(rows[0]!.lock_timeout, "0");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("puts back a lock timeout the transaction had set itself, not the default", async () => {
      const client = await begin(workspaceA);
      try {
        await client.query("SET LOCAL lock_timeout = '30s'");
        await claimIdempotencyKey(client, keyInput(randomUUID(), hash("own timeout")));
        const { rows } = await client.query<{ lock_timeout: string }>("SHOW lock_timeout");
        assert.equal(rows[0]!.lock_timeout, "30s");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });

  describe("a batchId claimed by two requests at once", () => {
    const entries = () => [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryA, amountCents: 100 }];

    it("makes the second wait, then replay the first's rows once it commits", async () => {
      const batchId = randomUUID();
      const outcome = await race(
        async (client) => {
          assert.deepEqual(await claimAssignmentBatch(client, workspaceA, batchId, hash("batch")), { kind: "claimed" });
          await createAssignmentBatch(client, { workspaceId: workspaceA, author: userId, entries: entries(), batchId });
        },
        (client) => claimAssignmentBatch(client, workspaceA, batchId, hash("batch")),
        "COMMIT",
      );
      assert.equal(outcome.kind, "replay");
      assert.equal(outcome.kind === "replay" ? outcome.entries.length : 0, 1);
      const { rows } = await superuserPool.query("SELECT 1 FROM assignment_ledger WHERE batch_id = $1", [batchId]);
      assert.equal(rows.length, 1);
    });

    it("lets the second claim the batch itself when the first rolls back", async () => {
      const batchId = randomUUID();
      const outcome = await race(
        async (client) => {
          await claimAssignmentBatch(client, workspaceA, batchId, hash("batch"));
        },
        (client) => claimAssignmentBatch(client, workspaceA, batchId, hash("batch")),
        "ROLLBACK",
      );
      assert.deepEqual(outcome, { kind: "claimed" });
    });
  });

  describe("isolation between workspaces", () => {
    it("keeps the same key in two workspaces apart, and shows each workspace only its own", async () => {
      const key = randomUUID();
      for (const workspaceId of [workspaceA, workspaceB]) {
        const outcome = await inWorkspace(workspaceId, async (client) => {
          const claimed = await claimIdempotencyKey(client, keyInput(key, hash(workspaceId), workspaceId));
          await storeIdempotentReply(client, workspaceId, key, 201, { workspaceId });
          return claimed;
        });
        assert.deepEqual(outcome, { kind: "claimed" }, "a key used in another workspace is new here");
      }
      const seenFromB = await inWorkspace(workspaceB, (client) =>
        client.query<{ workspace_id: string }>("SELECT workspace_id FROM idempotency_keys WHERE key = $1", [key]),
      );
      assert.deepEqual(seenFromB.rows, [{ workspace_id: workspaceB }]);
      const unscoped = await appPool.query("SELECT 1 FROM idempotency_keys WHERE key = $1", [key]);
      assert.equal(unscoped.rows.length, 0, "no workspace selected, nothing visible");
    });

    it("keeps the same batch id in two workspaces apart, and shows each workspace only its own", async () => {
      const batchId = randomUUID();
      for (const workspaceId of [workspaceA, workspaceB]) {
        const outcome = await inWorkspace(workspaceId, (client) => claimAssignmentBatch(client, workspaceId, batchId, hash("same")));
        assert.deepEqual(outcome, { kind: "claimed" });
      }
      const seenFromB = await inWorkspace(workspaceB, (client) =>
        client.query<{ workspace_id: string }>("SELECT workspace_id FROM assignment_batches WHERE id = $1", [batchId]),
      );
      assert.deepEqual(seenFromB.rows, [{ workspace_id: workspaceB }]);
    });

    it("does not let envelope_app write a key or a batch into another workspace", async () => {
      await assert.rejects(
        () => inWorkspace(workspaceA, (client) => claimIdempotencyKey(client, keyInput(randomUUID(), hash("x"), workspaceB))),
        /row-level security/,
      );
      await assert.rejects(
        () => inWorkspace(workspaceA, (client) => claimAssignmentBatch(client, workspaceB, randomUUID(), hash("x"))),
        /row-level security/,
      );
    });

    it("does not let envelope_app change a stored key's request or a batch", async () => {
      await assert.rejects(
        () => inWorkspace(workspaceA, (client) => client.query("UPDATE idempotency_keys SET request_hash = $1", [hash("y")])),
        /permission denied/,
      );
      await assert.rejects(
        () => inWorkspace(workspaceA, (client) => client.query("UPDATE assignment_batches SET request_hash = $1", [hash("y")])),
        /permission denied/,
      );
      await assert.rejects(() => inWorkspace(workspaceA, (client) => client.query("DELETE FROM assignment_batches")), /permission denied/);
    });
  });

  describe("the hourly sweep", () => {
    async function storeKey(workspaceId: string, age: string): Promise<string> {
      const key = randomUUID();
      await inWorkspace(workspaceId, async (client) => {
        await claimIdempotencyKey(client, keyInput(key, hash(key), workspaceId));
        await storeIdempotentReply(client, workspaceId, key, 201, {});
      });
      await superuserPool.query("UPDATE idempotency_keys SET created_at = now() - $2::interval WHERE key = $1", [key, age]);
      return key;
    }

    async function remaining(keys: readonly string[]): Promise<string[]> {
      const { rows } = await superuserPool.query<{ key: string }>("SELECT key FROM idempotency_keys WHERE key = ANY($1)", [keys]);
      return rows.map((row) => row.key).sort();
    }

    it("deletes only the keys older than 24 hours, in one workspace's own transaction", async () => {
      const expired = await storeKey(workspaceA, "24 hours 5 minutes");
      const fresh = await storeKey(workspaceA, "23 hours");
      const elsewhere = await storeKey(workspaceB, "30 hours");
      const deleted = await sweepWorkspaceIdempotencyKeys(appPool, workspaceA);
      assert.ok(deleted >= 1);
      assert.deepEqual(await remaining([expired, fresh, elsewhere]), [elsewhere, fresh].sort());
    });

    it("as a job, deletes the expired keys of every workspace and nothing else, as envelope_app", async () => {
      const expiredA = await storeKey(workspaceA, "25 hours");
      const expiredB = await storeKey(workspaceB, "2 days");
      const freshA = await storeKey(workspaceA, "1 minute");
      const freshB = await storeKey(workspaceB, "23 hours 59 minutes");
      const logged: Record<string, unknown>[] = [];
      const handler = createIdempotencyKeysSweepHandler(appPool, {
        info: (object) => logged.push(object),
        error: () => assert.fail("no workspace should fail"),
      });
      const jobClient = await appPool.connect();
      try {
        await jobClient.query("BEGIN");
        await handler({}, jobClient, randomUUID());
        // The flag is cleared once the workspaces are listed.
        const { rows } = await jobClient.query<{ flag: string }>("SELECT current_setting('app.is_system_job', true) AS flag");
        assert.equal(rows[0]!.flag, "");
        await jobClient.query("COMMIT");
      } finally {
        jobClient.release();
      }
      assert.deepEqual(await remaining([expiredA, expiredB, freshA, freshB]), [freshA, freshB].sort());
      assert.equal(logged.length, 1);
    });
  });
});
