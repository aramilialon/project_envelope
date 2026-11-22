import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "../test-helpers/isolated-database.ts";
import { ensureQueueRoleLogin, queueConnectionString } from "../test-helpers/queue-role.ts";
import { createPostgresQueueDriver, processJob } from "./postgres-driver.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

/**
 * Polls `check` until it returns true, failing with `description` after `timeoutMs` (#641): a
 * test waits for a state of the job tables, never for a fixed time.
 */
async function waitFor(description: string, check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The shortest polling interval pg-boss allows, so the one test that waits for a real delivery waits little (#641). */
const TEST_POLLING_INTERVAL_SECONDS = 0.5;

describe("postgres queue driver", () => {
  let superuserPool: DbPool;
  let appPool: DbPool;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureQueueRoleLogin(superuserPool);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(databaseUrl));
  });

  after(async () => {
    await appPool.end();
    await superuserPool.end();
  });

  /**
   * pg-boss's own rows for one job type, read as the superuser. Every test uses a job type of its
   * own, so another test file running at the same time (ADR 0016) never adds rows here.
   */
  async function jobRows(jobType: string): Promise<{ id: string; data: { n?: number }; state: string; singleton_key: string | null }[]> {
    const { rows } = await superuserPool.query<{ id: string; data: { n?: number }; state: string; singleton_key: string | null }>(
      "SELECT id, data, state, singleton_key FROM pgboss.job WHERE name = $1 ORDER BY (data->>'n')::int NULLS LAST",
      [jobType],
    );
    return rows;
  }

  /** Removes the jobs a test left waiting with no worker, its own job type's only. */
  async function deleteJobs(jobType: string): Promise<void> {
    await superuserPool.query("DELETE FROM pgboss.job WHERE name = $1", [jobType]);
  }

  it("enqueues a job and a registered worker processes it", async () => {
    // The one test that waits for pg-boss to really deliver a job, through a worker it registers.
    const driver = createPostgresQueueDriver(queueConnectionString(databaseUrl), appPool, {
      pollingIntervalSeconds: TEST_POLLING_INTERVAL_SECONDS,
    });
    await driver.start();
    try {
      const jobType = `test-job-${randomUUID()}`;

      let received: { greeting: string } | undefined;
      await driver.work<{ greeting: string }>(jobType, async (data) => {
        received = data;
      });
      const jobId = await driver.enqueue(jobType, { greeting: "hello" });
      assert.ok(jobId, "the enqueue must have created a job");

      // processed_jobs gets the job's id in the same transaction as the handler's own work (#36).
      await waitFor(`job ${jobId} to be marked processed in processed_jobs`, async () => {
        const { rows } = await appPool.query("SELECT 1 FROM processed_jobs WHERE job_id = $1", [jobId]);
        return rows.length === 1;
      });
      assert.deepEqual(received, { greeting: "hello" });
    } finally {
      await driver.stop();
    }
  });

  it("ignores a second enqueue with the same deduplication key while the first is still unprocessed", async () => {
    // No worker: both jobs stay "created" (never started) for as long as the test lasts, so the
    // job table itself shows that the duplicate was never created, not merely slow to arrive.
    const driver = createPostgresQueueDriver(queueConnectionString(databaseUrl), appPool);
    await driver.start();
    const jobType = `test-dedupe-${randomUUID()}`;
    try {
      const first = await driver.enqueue(jobType, { n: 1 }, { deduplicationKey: "dedupe-key" });
      const duplicate = await driver.enqueue(jobType, { n: 2 }, { deduplicationKey: "dedupe-key" });
      const other = await driver.enqueue(jobType, { n: 3 }, { deduplicationKey: "other-key" });

      assert.equal(duplicate, null, "the duplicate-keyed enqueue must report that it created nothing");
      assert.ok(first && other && first !== other, "each distinct key must create a job of its own");
      const rows = await jobRows(jobType);
      assert.deepEqual(
        rows.map((r) => ({ id: r.id, n: r.data.n, state: r.state, key: r.singleton_key })),
        [
          { id: first, n: 1, state: "created", key: "dedupe-key" },
          { id: other, n: 3, state: "created", key: "other-key" },
        ],
        "the duplicate-keyed job must never have been created",
      );
    } finally {
      await deleteJobs(jobType);
      await driver.stop();
    }
  });

  it("writes the job in the caller's own transaction, rolling back together with it", async () => {
    const driver = createPostgresQueueDriver(queueConnectionString(databaseUrl), appPool);
    await driver.start();
    try {
      const jobType = `test-outbox-${randomUUID()}`;

      async function enqueueWithWorkspace(n: number, outcome: "COMMIT" | "ROLLBACK"): Promise<string> {
        const workspaceId = randomUUID();
        const client = await superuserPool.connect();
        try {
          await client.query("BEGIN");
          await client.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Outbox test', 'EUR', 'UTC')", [
            workspaceId,
          ]);
          await driver.enqueue(jobType, { n, workspaceId }, {}, client);
          await client.query(outcome);
        } finally {
          client.release();
        }
        return workspaceId;
      }

      const rolledBack = await enqueueWithWorkspace(1, "ROLLBACK");
      const committed = await enqueueWithWorkspace(2, "COMMIT");
      try {
        // The committed write is the control: it proves the job table is where an enqueue through
        // the caller's transaction lands, so the rolled-back one's absence there means something.
        assert.deepEqual(
          (await jobRows(jobType)).map((r) => r.data.n),
          [2],
          "only the job written inside the committed transaction may have been queued",
        );
        const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM workspaces WHERE id = ANY($1)", [[rolledBack, committed]]);
        assert.deepEqual(
          rows.map((r) => r.id),
          [committed],
          "the rolled-back transaction's own write must be gone too",
        );
      } finally {
        await superuserPool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[rolledBack, committed]]);
        await deleteJobs(jobType);
      }
    } finally {
      await driver.stop();
    }
  });

  it("registers a periodic schedule without throwing", async () => {
    const driver = createPostgresQueueDriver(queueConnectionString(databaseUrl), appPool);
    await driver.start();
    try {
      const jobType = `test-schedule-${randomUUID()}`;

      await driver.schedule(jobType, "0 0 1 * *", { monthly: true });

      const { rows } = await superuserPool.query<{ cron: string }>("SELECT cron FROM pgboss.schedule WHERE name = $1", [jobType]);
      assert.equal(rows[0]?.cron, "0 0 1 * *");
    } finally {
      await driver.stop();
    }
  });
});

/**
 * processJob directly (#36): fast and deterministic, no pg-boss delivery or polling interval
 * involved — these are the module's own idempotency guarantees, tested as unit tests against
 * a real processed_jobs table, not as a slow round-trip through the whole driver.
 */
describe("processJob (#36)", () => {
  let superuserPool: DbPool;
  let appPool: DbPool;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(databaseUrl));
  });

  after(async () => {
    await appPool.end();
    await superuserPool.end();
  });

  it("runs the handler and marks the job processed", async () => {
    const jobType = `test-${randomUUID()}`;
    const jobId = randomUUID();
    let received: { n: number } | undefined;

    await processJob(appPool, jobType, jobId, { n: 1 }, async (data) => {
      received = data;
    });

    assert.deepEqual(received, { n: 1 });
    const { rows } = await appPool.query("SELECT job_type FROM processed_jobs WHERE job_id = $1", [jobId]);
    assert.equal(rows[0]?.job_type, jobType);
  });

  it("discards a repeat job id without running the handler again", async () => {
    const jobType = `test-${randomUUID()}`;
    const jobId = randomUUID();
    let runs = 0;
    const handler = async (): Promise<void> => {
      runs++;
    };

    await processJob(appPool, jobType, jobId, {}, handler);
    await processJob(appPool, jobType, jobId, {}, handler);

    assert.equal(runs, 1, "the second delivery of the same job id must never reach the handler");
  });

  it("sweeps rows past the 30-day retention before inserting the new one", async () => {
    const staleJobId = randomUUID();
    await appPool.query(
      "INSERT INTO processed_jobs (job_id, job_type, processed_at) VALUES ($1, 'stale-job-type', now() - interval '31 days')",
      [staleJobId],
    );

    await processJob(appPool, `test-${randomUUID()}`, randomUUID(), {}, async () => {});

    const { rows } = await appPool.query("SELECT 1 FROM processed_jobs WHERE job_id = $1", [staleJobId]);
    assert.equal(rows.length, 0, "a processed_jobs row past the 30-day retention must be swept");
  });

  it("lets a genuine handler error propagate, and does not mark the job processed", async () => {
    const jobType = `test-${randomUUID()}`;
    const jobId = randomUUID();

    await assert.rejects(
      () =>
        processJob(appPool, jobType, jobId, {}, async () => {
          throw new Error("a real bug in the handler, not a duplicate delivery");
        }),
      /a real bug in the handler/,
    );

    const { rows } = await appPool.query("SELECT 1 FROM processed_jobs WHERE job_id = $1", [jobId]);
    assert.equal(rows.length, 0, "a failed attempt must roll back its own processed_jobs row too, so pg-boss's retry gets a clean slate");
  });
});

/**
 * The sweep and a slow handler (#85): in a database of its own, so the stale row is swept by
 * this test's first job and no other file's.
 */
describe("processJob, the retention sweep next to a slow handler (#85)", () => {
  let database: IsolatedDatabase | undefined;
  let superuserPool: DbPool;
  let appPool: DbPool;

  before(async () => {
    database = await createIsolatedDatabase(databaseUrl);
    superuserPool = createPool(database.databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(database.databaseUrl));
  });

  after(async () => {
    try {
      await appPool?.end();
      await superuserPool?.end();
    } finally {
      await database?.drop();
    }
  });

  it("a handler still running does not hold up another job's sweep", { timeout: 15_000 }, async () => {
    await superuserPool.query(
      "INSERT INTO processed_jobs (job_id, job_type, processed_at) VALUES ($1, 'stale-job-type', now() - interval '31 days')",
      [randomUUID()],
    );
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let slowStarted = false;
    const slow = processJob(appPool, `test-${randomUUID()}`, randomUUID(), {}, async () => {
      slowStarted = true;
      await released;
    });
    try {
      await waitFor("the slow handler to start", async () => slowStarted);
      const otherJobId = randomUUID();
      const other = processJob(appPool, `test-${randomUUID()}`, otherJobId, {}, async () => {});
      const outcome = await Promise.race([
        other.then(() => "done" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 3000)),
      ]);
      assert.equal(outcome, "done", "the second job must not wait for the first one's handler");
      const { rows } = await superuserPool.query("SELECT 1 FROM processed_jobs WHERE job_id = $1", [otherJobId]);
      assert.equal(rows.length, 1);
    } finally {
      release();
      await slow;
    }
    const { rows } = await superuserPool.query("SELECT 1 FROM processed_jobs WHERE job_type = 'stale-job-type'");
    assert.equal(rows.length, 0, "the stale row is still swept");
  });
});
