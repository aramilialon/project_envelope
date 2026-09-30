/**
 * Certifies 0.1.6 Sync's own "done when" (#46): a harness with two synthetic "devices" — each
 * keeping its own local clock (HLC) and its own offline queue — makes offline changes,
 * including a conflicting one, then syncs; the result matches on both sides with no duplicate
 * or lost change. Against the real process (ADR 0007), not `.inject()`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { compareHlc, nextHlc, type Hlc } from "@envelope/core";
import { decodeJwt } from "jose";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
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

interface DownloadedChange {
  readonly entityId: string;
  readonly fieldName: string;
  readonly hlc: Hlc;
  readonly value: unknown;
}

/**
 * A synthetic device: its own HLC (ticks forward with every edit, `nextHlc`), its own offline
 * queue (edits made before the next `sync`), and its own local view of every field it has ever
 * uploaded or downloaded — what a real client's local database would hold.
 */
class SyncDevice {
  readonly id: string;
  private clock: Hlc | undefined;
  private since: Hlc | undefined;
  private queue: { id: string; entityId: string; fieldName: string; hlc: Hlc; value: unknown }[] = [];
  readonly local = new Map<string, unknown>();

  constructor(id: string) {
    this.id = id;
  }

  /** `physical` is only ever given explicitly for the one field two devices both edit, to make which one wins deterministic rather than a real-clock race. */
  edit(entityId: string, fieldName: string, value: unknown, physical: number = Date.now()): void {
    this.clock = nextHlc(physical, this.clock, this.id);
    this.queue.push({ id: randomUUID(), entityId, fieldName, hlc: this.clock, value });
    this.local.set(`${entityId}:${fieldName}`, value);
  }

  async sync(post: (body: unknown) => Promise<unknown>, get: (query: string) => Promise<{ changes: DownloadedChange[] }>): Promise<void> {
    if (this.queue.length > 0) {
      await post({ changes: this.queue });
      this.queue = [];
    }
    const query = this.since
      ? `?sincePhysical=${this.since.physical}&sinceCounter=${this.since.counter}&sinceDeviceId=${this.since.deviceId}`
      : "";
    const { changes } = await get(query);
    for (const change of changes) {
      this.local.set(`${change.entityId}:${change.fieldName}`, change.value);
      if (!this.since || compareHlc(change.hlc, this.since) > 0) {
        this.since = change.hlc;
      }
    }
  }
}

describe("smoke: 0.1.6 Sync, against the real process", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let server: RunningServer;
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
    await fetch(`${server.baseUrl}/workspaces/${workspaceId}/accounts`, { headers: { authorization: `Bearer ${token}` } });
    const subject = decodeJwt(token).sub;
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [subject]);
    const userId = rows[0]?.id;
    assert.ok(userId, "expected the user mapper to have created a local user for this token's subject");
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [
      userId,
      workspaceId,
    ]);

    accountId = await api<{ id: string }>("POST", "/accounts", { name: "Checking", type: "checking", currency: "EUR" }).then(
      (a) => a.id,
    );
  });

  after(async () => {
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

  async function createTransaction(): Promise<string> {
    const transaction = await api<{ id: string }>("POST", `/accounts/${accountId}/transactions`, {
      occurredAt: "2026-09-01",
      splits: [{ categoryId: null, amountCents: 1000 }],
    });
    return transaction.id;
  }

  it("converges two devices' offline edits, including a conflict, with no lost or duplicate change", async () => {
    const sharedTransactionId = await createTransaction();
    const onlyATransactionId = await createTransaction();
    const onlyBTransactionId = await createTransaction();

    const deviceA = new SyncDevice("smoke-device-a");
    const deviceB = new SyncDevice("smoke-device-b");

    // Both devices edit the same field of the same transaction while offline, neither aware of
    // the other — a genuine conflict. B's is given a later physical clock (still real wall-clock
    // time, just nudged forward, so it stays in the same domain as every other edit's own
    // Date.now() — an artificially tiny physical here would make the "since" cursor from a later,
    // real-timestamped edit skip straight past it), so it must win on both sides regardless of
    // which device syncs first or how fast this test itself runs.
    const conflictBase = Date.now();
    deviceA.edit(sharedTransactionId, "transactions.memo", "from A", conflictBase);
    deviceB.edit(sharedTransactionId, "transactions.memo", "from B", conflictBase + 1_000);
    // Each device also edits a transaction the other never touches — proves nothing is lost.
    deviceA.edit(onlyATransactionId, "transactions.payee", "A's payee");
    deviceB.edit(onlyBTransactionId, "transactions.payee", "B's payee");

    async function getChanges(query: string): Promise<{ changes: DownloadedChange[] }> {
      return api<{ changes: DownloadedChange[] }>("GET", `/changes${query}`);
    }
    async function postChanges(body: unknown): Promise<unknown> {
      return api("POST", "/changes", body);
    }

    await deviceA.sync(postChanges, getChanges);
    await deviceB.sync(postChanges, getChanges);
    // A syncs again to pick up what B uploaded — exactly what a real device does the next time
    // it comes online.
    await deviceA.sync(postChanges, getChanges);

    const sharedKey = `${sharedTransactionId}:transactions.memo`;
    const onlyAKey = `${onlyATransactionId}:transactions.payee`;
    const onlyBKey = `${onlyBTransactionId}:transactions.payee`;

    // Convergence: both devices end up with the exact same view.
    assert.deepEqual(
      [deviceA.local.get(sharedKey), deviceA.local.get(onlyAKey), deviceA.local.get(onlyBKey)],
      [deviceB.local.get(sharedKey), deviceB.local.get(onlyAKey), deviceB.local.get(onlyBKey)],
    );
    // The later clock won the conflict, on both sides.
    assert.equal(deviceA.local.get(sharedKey), "from B");
    assert.equal(deviceB.local.get(sharedKey), "from B");
    // Nothing lost: each device's own non-conflicting edit reached the other.
    assert.equal(deviceA.local.get(onlyBKey), "B's payee");
    assert.equal(deviceB.local.get(onlyAKey), "A's payee");

    // No duplicate: the real column holds exactly one value, and a retried upload (a network
    // resend of the same change id) does not create a second change_log row or flip the result.
    const { rows: transactionRows } = await superuserPool.query<{ memo: string | null }>(
      "SELECT memo FROM transactions WHERE id = $1",
      [sharedTransactionId],
    );
    assert.equal(transactionRows[0]?.memo, "from B");

    // A new change, tied with B's own winning one on the exact same HLC (as a resend of the
    // very same upload would be): it must not overwrite the real column (a tie is stale, never
    // applied — #43), and resending it must never create a second change_log row.
    const retriedChange = {
      id: randomUUID(),
      entityId: sharedTransactionId,
      fieldName: "transactions.memo",
      hlc: { physical: conflictBase + 1_000, counter: 0, deviceId: "smoke-device-b" },
      value: "resent",
    };
    await postChanges({ changes: [retriedChange] });
    await postChanges({ changes: [retriedChange] }); // the exact same change id again, as a retry would resend it

    const { rows: changeLogRows } = await superuserPool.query("SELECT 1 FROM change_log WHERE id = $1", [retriedChange.id]);
    assert.equal(changeLogRows.length, 1, "resending the same change id must never create a duplicate row");
    const { rows: afterRetry } = await superuserPool.query<{ memo: string | null }>(
      "SELECT memo FROM transactions WHERE id = $1",
      [sharedTransactionId],
    );
    assert.equal(afterRetry[0]?.memo, "from B", "the real column must be unaffected by a resend that changes nothing new");
  });
});
