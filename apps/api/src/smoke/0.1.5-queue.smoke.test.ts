/**
 * Milestone 0.1.5 ("Queue and notifications") never got a smoke test of its own (ADR 0007) —
 * found while wiring `#38`'s own periodic job. Certifies that a job registered with
 * `queue.work` in the real, running process (`main.ts`, started as a subprocess — not
 * `buildApp()`+`.inject()`) actually gets delivered and does its real work: enqueuing
 * `scheduled-transactions-fire` from a second, independent queue connection (standing in for
 * the real cron tick `queue.schedule` registers in `main.ts`, which this test cannot wait a
 * real hour for) and polling the real HTTP API until the overdue scheduled transaction it
 * materializes shows up.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { decodeJwt } from "jose";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { createQueueDriver, type QueueDriver } from "../queue/index.ts";
import { SCHEDULED_TRANSACTIONS_FIRE_JOB } from "../queue/job-types.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { ensureQueueRoleLogin, queueConnectionString } from "../test-helpers/queue-role.ts";
import { TEST_VAPID_PRIVATE_KEY, TEST_VAPID_PUBLIC_KEY, TEST_VAPID_SUBJECT } from "../test-helpers/vapid-keys.ts";
import { startServer, type RunningServer } from "./support.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}
if (!process.env.KEYCLOAK_ADMIN_PASSWORD) {
  throw new Error("Set KEYCLOAK_ADMIN_PASSWORD (the value from infra/.env) before running the integration tests");
}

describe("smoke: 0.1.5 Queue, against the real process", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let server: RunningServer;
  let producer: QueueDriver;
  let token: string;
  let workspaceId: string;
  let accountId: string;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    await ensureQueueRoleLogin(superuserPool);
    realm = await setUpKeycloakTestRealm();

    server = await startServer({
      HOST: "127.0.0.1",
      PORT: "3906",
      APP_DATABASE_URL: appConnectionString(databaseUrl),
      QUEUE_DATABASE_URL: queueConnectionString(databaseUrl),
      VAPID_SUBJECT: TEST_VAPID_SUBJECT,
      VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
      KEYCLOAK_ISSUER: realm.issuer,
      KEYCLOAK_AUDIENCE: realm.audience,
      LOG_LEVEL: "fatal",
    });

    workspaceId = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Smoke', 'EUR', 'UTC')",
      [workspaceId],
    );

    token = await realm.getUserToken();
    await fetch(`${server.baseUrl}/workspaces/${workspaceId}/accounts`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const subject = decodeJwt(token).sub;
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      subject,
    ]);
    const userId = rows[0]?.id;
    assert.ok(userId, "expected the user mapper to have created a local user for this token's subject");
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [
      userId,
      workspaceId,
    ]);

    const groupId = await api<{ id: string }>("POST", "/category-groups", { name: "Everyday" }).then((r) => r.id);
    const categoryId = await api<{ id: string }>("POST", "/categories", { name: "Rent", groupId }).then((r) => r.id);
    accountId = await api<{ id: string }>("POST", "/accounts", { name: "Checking", type: "checking", currency: "EUR" }).then(
      (r) => r.id,
    );
    await api("POST", "/scheduled-transactions", {
      accountId,
      payee: "Smoke rent",
      nextDueDate: "2020-01-01",
      recurEvery: 100,
      recurUnit: "year",
      splits: [{ categoryId, amountCents: 1_000 }],
    });

    // A second, independent producer connection — standing in for the real cron tick
    // `queue.schedule` registers in the server's own process, which this test cannot wait a
    // real hour for. The server's own `queue.work` registration is what actually processes it.
    producer = createQueueDriver({ driver: "postgres", databaseUrl: queueConnectionString(databaseUrl) }, superuserPool);
    await producer.start();
  });

  after(async () => {
    await producer.stop();
    await server.stop();
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await realm.teardown();
    await superuserPool.end();
  });

  function auth(): Record<string, string> {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${server.baseUrl}/workspaces/${workspaceId}${path}`, {
      method,
      headers: auth(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path} responded ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  it("materializes an overdue scheduled transaction once the job is delivered", async () => {
    await producer.enqueue(SCHEDULED_TRANSACTIONS_FIRE_JOB, {});

    const deadline = Date.now() + 10_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      const { transactions } = await api<{ transactions: readonly { payee: string | null }[] }>(
        "GET",
        `/accounts/${accountId}/transactions`,
      );
      found = transactions.some((t) => t.payee === "Smoke rent");
      if (!found) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    assert.ok(found, "expected the real running process to have recorded the overdue scheduled transaction");
  });
});
