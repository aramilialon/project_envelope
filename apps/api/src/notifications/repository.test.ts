import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import type { PushDriver, PushOutcome, PushPayload } from "./driver.ts";
import { sendPushToUser, type PushDrivers } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

/** Records every call, and returns whatever outcome the test configured for it — no real network call. */
function fakePushDriver(outcome: PushOutcome = "sent"): PushDriver & { calls: { token: string; payload: PushPayload }[] } {
  const calls: { token: string; payload: PushPayload }[] = [];
  return {
    calls,
    async send(token, payload) {
      calls.push({ token, payload });
      return outcome;
    },
  };
}

describe("notifications repository", () => {
  let pool: DbPool;
  let userId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
  });

  after(async () => {
    await pool.end();
  });

  async function createUser(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>("INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id", [
      randomUUID(),
      `${randomUUID()}@example.com`,
    ]);
    return rows[0]!.id;
  }

  async function addDevice(forUserId: string, platform: "ios" | "android" | "web", token: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO device_tokens (user_id, platform, token) VALUES ($1, $2, $3) RETURNING id",
      [forUserId, platform, token],
    );
    return rows[0]!.id;
  }

  before(async () => {
    userId = await createUser();
  });

  it("sends to every registered device and records each delivery as sent", async () => {
    const user = await createUser();
    const webDriver = fakePushDriver("sent");
    const iosDriver = fakePushDriver("sent");
    const drivers: PushDrivers = { web: webDriver, ios: iosDriver, android: fakePushDriver("sent") };
    await addDevice(user, "web", "web-token-1");
    await addDevice(user, "ios", "ios-token-1");

    const jobId = randomUUID();
    await sendPushToUser(pool, drivers, jobId, user, { title: "Overspent", body: "Groceries is negative" });

    assert.equal(webDriver.calls.length, 1);
    assert.equal(iosDriver.calls.length, 1);
    assert.equal(webDriver.calls[0]?.payload.notificationId, jobId);

    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM notification_deliveries d JOIN device_tokens t ON t.id = d.device_token_id WHERE t.user_id = $1 AND d.job_id = $2",
      [user, jobId],
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === "sent"));
  });

  it("does not re-deliver to a device already marked sent for the same job", async () => {
    const user = await createUser();
    const driver = fakePushDriver("sent");
    const drivers: PushDrivers = { web: driver, ios: fakePushDriver(), android: fakePushDriver() };
    await addDevice(user, "web", "web-token-2");
    const jobId = randomUUID();

    await sendPushToUser(pool, drivers, jobId, user, { title: "T", body: "B" });
    await sendPushToUser(pool, drivers, jobId, user, { title: "T", body: "B" });

    assert.equal(driver.calls.length, 1, "a device already marked sent for this job must never be sent to again");
  });

  it("deletes the device token when the driver reports it invalid, taking its delivery row with it", async () => {
    const user = await createUser();
    const driver = fakePushDriver("invalid_token");
    const drivers: PushDrivers = { web: driver, ios: fakePushDriver(), android: fakePushDriver() };
    const deviceId = await addDevice(user, "web", "web-token-3");
    const jobId = randomUUID();

    await sendPushToUser(pool, drivers, jobId, user, { title: "T", body: "B" });

    const { rows: tokens } = await pool.query("SELECT 1 FROM device_tokens WHERE id = $1", [deviceId]);
    assert.equal(tokens.length, 0, "an invalid token must be removed so no future job wastes a delivery on it");
    // notification_deliveries.device_token_id cascades on delete: once the device itself is
    // gone there is no destination left for this delivery to describe, so it goes with it.
    const { rows: deliveries } = await pool.query("SELECT 1 FROM notification_deliveries WHERE job_id = $1", [jobId]);
    assert.equal(deliveries.length, 0);
  });

  it("leaves the delivery pending on a transient failure, for a future retry", async () => {
    const user = await createUser();
    const driver = fakePushDriver("failed");
    const drivers: PushDrivers = { web: driver, ios: fakePushDriver(), android: fakePushDriver() };
    const deviceId = await addDevice(user, "web", "web-token-4");
    const jobId = randomUUID();

    await sendPushToUser(pool, drivers, jobId, user, { title: "T", body: "B" });

    const { rows } = await pool.query<{ status: string }>("SELECT status FROM notification_deliveries WHERE job_id = $1", [jobId]);
    assert.equal(rows[0]?.status, "pending");
    const { rows: tokens } = await pool.query("SELECT 1 FROM device_tokens WHERE id = $1", [deviceId]);
    assert.equal(tokens.length, 1, "a merely transient failure must not remove the token");
  });

  it("retries only the still-pending device after a partial failure, on a second call", async () => {
    const user = await createUser();
    let webCalls = 0;
    const webDriver: PushDriver = {
      async send() {
        webCalls++;
        return webCalls === 1 ? "failed" : "sent";
      },
    };
    const iosDriver = fakePushDriver("sent");
    const drivers: PushDrivers = { web: webDriver, ios: iosDriver, android: fakePushDriver() };
    await addDevice(user, "web", "web-token-5");
    await addDevice(user, "ios", "ios-token-5");
    const jobId = randomUUID();

    await sendPushToUser(pool, drivers, jobId, user, { title: "T", body: "B" });
    assert.equal(iosDriver.calls.length, 1);

    // A retry of the same job: the ios device already succeeded and must not be touched again.
    await sendPushToUser(pool, drivers, jobId, user, { title: "T", body: "B" });
    assert.equal(webCalls, 2, "the still-pending web device must be retried");
    assert.equal(iosDriver.calls.length, 1, "the already-sent ios device must not be delivered to again");
  });
});
