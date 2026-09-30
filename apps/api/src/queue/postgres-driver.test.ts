import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { ensureQueueRoleLogin, queueConnectionString } from "../test-helpers/queue-role.ts";
import { createPostgresQueueDriver } from "./postgres-driver.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe("postgres queue driver", () => {
  let superuserPool: DbPool;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureQueueRoleLogin(superuserPool);
  });

  after(async () => {
    await superuserPool.end();
  });

  it("enqueues a job and a registered worker processes it", async () => {
    const driver = createPostgresQueueDriver(queueConnectionString(databaseUrl));
    await driver.start();
    const jobType = `test-job-${randomUUID()}`;

    let received: { greeting: string } | undefined;
    await driver.work<{ greeting: string }>(jobType, async (data) => {
      received = data;
    });
    await driver.enqueue(jobType, { greeting: "hello" });

    await waitUntil(() => received !== undefined);
    assert.deepEqual(received, { greeting: "hello" });

    await driver.stop();
  });

  it("ignores a second enqueue with the same deduplication key while the first is still unprocessed", async () => {
    const driver = createPostgresQueueDriver(queueConnectionString(databaseUrl));
    await driver.start();
    const jobType = `test-dedupe-${randomUUID()}`;

    const received: { n: number }[] = [];
    // A run date in the near future keeps both enqueue calls "still pending" (never started)
    // long enough to prove the second one was rejected, not just processed very quickly.
    const runAt = new Date(Date.now() + 2000);
    await driver.enqueue(jobType, { n: 1 }, { deduplicationKey: "dedupe-key", runAt });
    await driver.enqueue(jobType, { n: 2 }, { deduplicationKey: "dedupe-key", runAt });
    await driver.enqueue(jobType, { n: 3 }, { deduplicationKey: "other-key", runAt });

    await driver.work<{ n: number }>(jobType, async (data) => {
      received.push(data);
    });

    await waitUntil(() => received.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 500)); // give a would-be third delivery a chance to arrive
    assert.equal(received.length, 2, "the duplicate-keyed job must never have been created, not merely slow to arrive");
    assert.deepEqual(
      received.map((r) => r.n).sort(),
      [1, 3],
    );

    await driver.stop();
  });

  it("writes the job in the caller's own transaction, rolling back together with it", async () => {
    const driver = createPostgresQueueDriver(queueConnectionString(databaseUrl));
    await driver.start();
    const jobType = `test-outbox-${randomUUID()}`;

    let received = false;
    await driver.work<object>(jobType, async () => {
      received = true;
    });

    const workspaceId = randomUUID();
    const client = await superuserPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Rolled back', 'EUR', 'UTC')", [
        workspaceId,
      ]);
      await driver.enqueue(jobType, { workspaceId }, {}, client);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    await new Promise((resolve) => setTimeout(resolve, 3000)); // long enough for at least one poll if the job had survived
    assert.equal(received, false, "a job written inside a rolled-back transaction must not have been queued");

    await driver.stop();
  });

  it("registers a periodic schedule without throwing", async () => {
    const driver = createPostgresQueueDriver(queueConnectionString(databaseUrl));
    await driver.start();
    const jobType = `test-schedule-${randomUUID()}`;

    await driver.schedule(jobType, "0 0 1 * *", { monthly: true });

    const { rows } = await superuserPool.query<{ cron: string }>(
      "SELECT cron FROM pgboss.schedule WHERE name = $1",
      [jobType],
    );
    assert.equal(rows[0]?.cron, "0 0 1 * *");

    await driver.stop();
  });
});
