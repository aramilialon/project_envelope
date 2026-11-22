/**
 * Certifies 0.2.1 Price tracking & performance against the real process (ADR 0007: one file per
 * milestone): the actual server (main.ts) as a subprocess, driven over real HTTP connections, not
 * buildApp()+inject(). Each issue of the milestone that needs a smoke case adds a top-level
 * `describe` of its own, with its own server, realm and workspace.
 *
 * Idempotent creates (#559, ADR 0020): a create sent twice under the same `Idempotency-Key` records
 * once and answers the same; the same key with another body is refused; an assignment batch sent
 * twice under the same `batchId` appends once.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";

import { decodeJwt } from "jose";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { ensureQueueRoleLogin, queueConnectionString } from "../test-helpers/queue-role.ts";
import { TEST_VAPID_PRIVATE_KEY, TEST_VAPID_PUBLIC_KEY, TEST_VAPID_SUBJECT } from "../test-helpers/vapid-keys.ts";
import { printServerOutputOnFailure, startServer, type RunningServer } from "./support.ts";

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

describe("smoke: 0.2.1 idempotent creates, against the real process", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let server: RunningServer;
  let token: string;
  let workspaceId: string;
  let accountId: string;
  let categoryId: string;

  afterEach(printServerOutputOnFailure(() => [server]));

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    await ensureQueueRoleLogin(superuserPool);
    realm = await setUpKeycloakTestRealm();

    server = await startServer({
      HOST: "127.0.0.1",
      APP_DATABASE_URL: appConnectionString(databaseUrl),
      QUEUE_DATABASE_URL: queueConnectionString(databaseUrl),
      VAPID_SUBJECT: TEST_VAPID_SUBJECT,
      VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
      KEYCLOAK_ISSUER: realm.issuer,
      KEYCLOAK_AUDIENCE: realm.audience,
      MARKET_DATA_FETCH_ENABLED: "false",
      LOG_LEVEL: "warn",
    });

    workspaceId = randomUUID();
    await superuserPool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Smoke 0.2.1', 'EUR', 'UTC')", [
      workspaceId,
    ]);
    token = await realm.getUserToken();
    await fetch(`${server.baseUrl}/workspaces/${workspaceId}/accounts`, { headers: { authorization: `Bearer ${token}` } });
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [decodeJwt(token).sub]);
    assert.ok(rows[0], "expected the user mapper to have created a local user for this token's subject");
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [rows[0].id, workspaceId]);

    accountId = (await json<{ id: string }>(call("POST", "/accounts", { name: "Checking", type: "checking", currency: "EUR" }))).id;
    const group = await json<{ id: string }>(call("POST", "/category-groups", { name: "Home" }));
    categoryId = (await json<{ id: string }>(call("POST", "/categories", { groupId: group.id, name: "Groceries" }))).id;
  });

  after(async () => {
    await server.stop();
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await realm.teardown();
    await superuserPool.end();
  });

  async function call(method: string, path: string, body?: unknown, key?: string): Promise<Response> {
    return fetch(`${server.baseUrl}/workspaces/${workspaceId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(key !== undefined ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function json<T>(response: Promise<Response>): Promise<T> {
    return (await (await response).json()) as T;
  }

  it("records a transaction sent twice under the same key once, and answers the second with the first reply", async () => {
    const key = randomUUID();
    const body = { occurredAt: "2026-09-15", payee: "Smoke retry", splits: [{ categoryId, amountCents: -4_200 }] };
    const first = await call("POST", `/accounts/${accountId}/transactions`, body, key);
    assert.equal(first.status, 201);
    const second = await call("POST", `/accounts/${accountId}/transactions`, body, key);
    assert.equal(second.status, 201);
    assert.equal(second.headers.get("idempotent-replayed"), "true");
    const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
    assert.deepEqual(secondBody, firstBody);

    const list = await json<{ transactions: { payee: string | null }[] }>(call("GET", `/accounts/${accountId}/transactions`));
    assert.equal(list.transactions.filter((t) => t.payee === "Smoke retry").length, 1);
  });

  it("refuses the same key with another body as id_conflict", async () => {
    const key = randomUUID();
    const body = { occurredAt: "2026-09-16", payee: "Smoke conflict", splits: [{ categoryId, amountCents: -1_000 }] };
    assert.equal((await call("POST", `/accounts/${accountId}/transactions`, body, key)).status, 201);
    const other = await call("POST", `/accounts/${accountId}/transactions`, { ...body, splits: [{ categoryId, amountCents: -1_001 }] }, key);
    assert.equal(other.status, 409);
    assert.deepEqual(await other.json(), { error: "id_conflict", details: { field: "Idempotency-Key" } });
  });

  it("appends an assignment batch sent twice under the same batchId once", async () => {
    const batchId = randomUUID();
    const body = { batchId, entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 2_500 }] };
    const first = await call("POST", "/assignments", body);
    assert.equal(first.status, 201);
    const second = await call("POST", "/assignments", body);
    assert.equal(second.status, 201);
    assert.deepEqual(await second.json(), await first.json());
    const month = await json<{ categories: { categoryId: string; assigned: number }[] }>(call("GET", "/budget-months/2026-09"));
    const groceries = month.categories.find((c) => c.categoryId === categoryId);
    assert.equal(groceries?.assigned, 2_500, "assigned once, not twice");
  });
});
