/**
 * Certifies the cursor paging of an account's transactions (#560, milestone 0.2.1) against the
 * real process (ADR 0007): the actual server (main.ts) as a subprocess, driven over real HTTP
 * connections, not buildApp()+inject(). One case that succeeds (every page of an account, in
 * both orders, each row once) and one that must fail (a cursor of another account, and one that
 * does not decode, refused with `invalid_cursor`).
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

interface Page {
  readonly transactions: readonly { readonly id: string; readonly budgetDate: string }[];
  readonly nextCursor: string | null;
}

describe("smoke: 0.2.1 transaction paging, against the real process", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let server: RunningServer;
  let token: string;
  const workspaceId = randomUUID();
  let accountId: string;
  let otherAccountId: string;
  const created: string[] = [];

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
      LOG_LEVEL: "warn",
    });

    token = await realm.getUserToken();
    const me = await fetch(`${server.baseUrl}/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200);
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Smoke 0.2.1 paging', 'EUR', 'Europe/Rome')",
      [workspaceId],
    );
    const user = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [decodeJwt(token).sub]);
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [
      user.rows[0]!.id,
      workspaceId,
    ]);
    const accounts = await superuserPool.query<{ id: string }>(
      `INSERT INTO accounts (workspace_id, name, type, currency, on_budget)
       VALUES ($1, 'Checking', 'checking', 'EUR', true), ($1, 'Savings', 'savings', 'EUR', true) RETURNING id`,
      [workspaceId],
    );
    accountId = accounts.rows[0]!.id;
    otherAccountId = accounts.rows[1]!.id;

    // Seven income rows over the real API: four on one date, so the pages split a tie.
    for (const date of ["2026-09-01", "2026-09-02", "2026-09-02", "2026-09-02", "2026-09-02", "2026-09-03", "2026-09-04"]) {
      const response = await api("POST", `/accounts/${accountId}/transactions`, {
        occurredAt: date,
        payee: "Smoke",
        splits: [{ categoryId: null, amountCents: 1_000 }],
      });
      assert.equal(response.status, 201, await response.clone().text());
      created.push(((await response.json()) as { id: string }).id);
    }
  });

  after(async () => {
    await server.stop();
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await realm.teardown();
    await superuserPool.end();
  });

  function api(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${server.baseUrl}/workspaces/${workspaceId}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function walk(order: "asc" | "desc"): Promise<{ ids: string[]; dates: string[]; pages: number }> {
    const ids: string[] = [];
    const dates: string[] = [];
    let pages = 0;
    let cursor: string | null = null;
    do {
      const query: string = `?limit=2&order=${order}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response = await api("GET", `/accounts/${accountId}/transactions${query}`);
      assert.equal(response.status, 200);
      const page = (await response.json()) as Page;
      ids.push(...page.transactions.map((t) => t.id));
      dates.push(...page.transactions.map((t) => t.budgetDate));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    return { ids, dates, pages };
  }

  it("returns every transaction once over real HTTP, page by page, in either order", async () => {
    const asc = await walk("asc");
    assert.equal(asc.pages, 4); // 7 rows, 2 a page
    assert.deepEqual([...asc.ids].sort(), [...created].sort());
    assert.deepEqual(asc.dates, [...asc.dates].sort());

    const desc = await walk("desc");
    assert.deepEqual(desc.ids, [...asc.ids].reverse());
  });

  it("refuses over real HTTP a cursor of another account, and one that does not decode, with invalid_cursor", async () => {
    const first = (await (await api("GET", `/accounts/${accountId}/transactions?limit=1`)).json()) as Page;
    assert.ok(first.nextCursor);

    const foreign = await api("GET", `/accounts/${otherAccountId}/transactions?cursor=${encodeURIComponent(first.nextCursor)}`);
    assert.equal(foreign.status, 400);
    assert.deepEqual(await foreign.json(), { error: "invalid_cursor", details: {} });

    const garbage = await api("GET", `/accounts/${accountId}/transactions?cursor=not-a-cursor`);
    assert.equal(garbage.status, 400);
    assert.deepEqual(await garbage.json(), { error: "invalid_cursor", details: {} });
  });
});
