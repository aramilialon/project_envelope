import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { MAX_FREE_TEXT_LENGTH } from "@envelope/core";

import { decodeJwt } from "jose";

import { buildApp, type App } from "../app.ts";
import { loadConfig } from "../config.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../test-helpers/keycloak.ts";

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

describe("sync routes (#43, #44)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let accountId: string;
  let transactionId: string;
  let otherWorkspaceId: string;
  let otherTransactionId: string;
  let token: string;

  /** A new transaction of the selected workspace, for a test whose changes must not touch another test's. */
  async function newTransaction(): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO transactions (workspace_id, account_id, occurred_at, status) VALUES ($1, $2, now(), 'pending') RETURNING id",
      [workspaceId, accountId],
    );
    return rows[0]!.id;
  }

  async function tokenFor(role: "owner" | "editor" | "read_only"): Promise<string> {
    const t = role === "owner" ? await realm.getUserToken() : await realm.getTokenForNewUser();
    await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts`, headers: { authorization: `Bearer ${t}` } });
    const subject = decodeJwt(t).sub;
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [subject]);
    const userId = rows[0]?.id;
    assert.ok(userId, "expected the user mapper to have created a local user for this token's subject");
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [
      userId,
      workspaceId,
      role,
    ]);
    return t;
  }

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    realm = await setUpKeycloakTestRealm();

    app = buildApp(
      loadConfig({
        APP_DATABASE_URL: appConnectionString(databaseUrl),
        KEYCLOAK_ISSUER: realm.issuer,
        KEYCLOAK_AUDIENCE: realm.audience,
      }),
    );

    workspaceId = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Mine', 'EUR', 'Europe/Rome')",
      [workspaceId],
    );
    const account = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    accountId = account.rows[0]!.id;
    const transaction = await superuserPool.query<{ id: string }>(
      "INSERT INTO transactions (workspace_id, account_id, occurred_at, status) VALUES ($1, $2, now(), 'pending') RETURNING id",
      [workspaceId, accountId],
    );
    transactionId = transaction.rows[0]!.id;

    otherWorkspaceId = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Not mine', 'EUR', 'Europe/Rome')",
      [otherWorkspaceId],
    );
    const otherAccount = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [otherWorkspaceId],
    );
    const otherTransaction = await superuserPool.query<{ id: string }>(
      "INSERT INTO transactions (workspace_id, account_id, occurred_at, status, memo) VALUES ($1, $2, now(), 'pending', 'theirs') RETURNING id",
      [otherWorkspaceId, otherAccount.rows[0]!.id],
    );
    otherTransactionId = otherTransaction.rows[0]!.id;

    token = await tokenFor("owner");
  });

  after(async () => {
    await app.close();
    await superuserPool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[workspaceId, otherWorkspaceId]]);
    await realm.teardown();
    await superuserPool.end();
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({ method: "POST", url: `/workspaces/${workspaceId}/changes`, payload: { changes: [] } });
    assert.equal(response.statusCode, 401);
  });

  it("rejects a read-only member", async () => {
    const readOnlyToken = await tokenFor("read_only");
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${readOnlyToken}` },
      payload: { changes: [{ id: randomUUID(), entityId: transactionId, fieldName: "transactions.memo", hlc: { physical: 1, counter: 0, deviceId: "d" }, value: "x" }] },
    });
    assert.equal(response.statusCode, 403);
  });

  it("rejects a malformed body", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${token}` },
      payload: { changes: [{ id: randomUUID() }] },
    });
    assert.equal(response.statusCode, 400);
  });

  it("applies a batch of changes and reports each one's outcome", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        changes: [
          {
            id: randomUUID(),
            entityId: transactionId,
            fieldName: "transactions.memo",
            hlc: { physical: 2000, counter: 0, deviceId: "device-a" },
            value: "later",
          },
          {
            id: randomUUID(),
            entityId: transactionId,
            fieldName: "transactions.memo",
            hlc: { physical: 1000, counter: 0, deviceId: "device-b" },
            value: "earlier",
          },
          {
            id: randomUUID(),
            entityId: transactionId,
            fieldName: "transactions.occurred_at",
            hlc: { physical: 1000, counter: 0, deviceId: "device-a" },
            value: "2026-10-01",
          },
        ],
      },
    });

    assert.equal(response.statusCode, 201);
    const { results } = response.json() as { results: { id: string; outcome: string }[] };
    assert.deepEqual(
      results.map((r) => r.outcome),
      ["applied", "stale", "unsupported_field"],
    );

    const listed = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: { authorization: `Bearer ${token}` },
    });
    const { transactions } = listed.json() as { transactions: { id: string; memo: string | null }[] };
    assert.equal(transactions.find((t) => t.id === transactionId)?.memo, "later");
  });

  it("rejects a change to a reconciled transaction as locked (#45)", async () => {
    const reconciled = await superuserPool.query<{ id: string }>(
      "INSERT INTO transactions (workspace_id, account_id, occurred_at, status) VALUES ($1, $2, now(), 'reconciled') RETURNING id",
      [workspaceId, accountId],
    );
    const reconciledTransactionId = reconciled.rows[0]!.id;

    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        changes: [
          {
            id: randomUUID(),
            entityId: reconciledTransactionId,
            fieldName: "transactions.memo",
            hlc: { physical: 1000, counter: 0, deviceId: "d" },
            value: "should not apply",
          },
        ],
      },
    });

    assert.equal(response.statusCode, 201);
    const { results } = response.json() as { results: { outcome: string }[] };
    assert.deepEqual(
      results.map((r) => r.outcome),
      ["locked"],
    );
  });

  it("downloads every change when given no since, in clock order", async () => {
    const entityId = await newTransaction();
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        changes: [
          { id: randomUUID(), entityId, fieldName: "transactions.memo", hlc: { physical: 9000, counter: 0, deviceId: "d" }, value: "b" },
          { id: randomUUID(), entityId, fieldName: "transactions.memo", hlc: { physical: 8000, counter: 0, deviceId: "d" }, value: "a" },
        ],
      },
    });

    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    const { changes } = response.json() as { changes: { entityId: string; value: unknown }[] };
    const mine = changes.filter((c) => c.entityId === entityId);
    assert.deepEqual(
      mine.map((c) => c.value),
      ["a", "b"],
    );
  });

  it("downloads only changes later than the given since clock", async () => {
    const entityId = await newTransaction();
    await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        changes: [
          { id: randomUUID(), entityId, fieldName: "transactions.memo", hlc: { physical: 10000, counter: 0, deviceId: "d" }, value: "old" },
          { id: randomUUID(), entityId, fieldName: "transactions.memo", hlc: { physical: 11000, counter: 0, deviceId: "d" }, value: "new" },
        ],
      },
    });

    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/changes?sincePhysical=10000&sinceCounter=0&sinceDeviceId=d`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    const { changes } = response.json() as { changes: { entityId: string; value: unknown }[] };
    assert.deepEqual(
      changes.filter((c) => c.entityId === entityId).map((c) => c.value),
      ["new"],
    );
  });

  it("rejects a partial since (not all three of physical/counter/deviceId given)", async () => {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/changes?sincePhysical=1000`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 400);
  });

  it("allows a read-only member to download changes", async () => {
    const readOnlyToken = await tokenFor("read_only");
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/changes`,
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    assert.equal(response.statusCode, 200);
  });

  describe("text fields (#507)", () => {
    /** The transaction's own payee and memo, and how many change_log rows the workspace has. */
    async function snapshot(): Promise<{ payee: string | null; memo: string | null; changeLogRows: number }> {
      const row = await superuserPool.query<{ payee: string | null; memo: string | null }>(
        "SELECT payee, memo FROM transactions WHERE id = $1",
        [transactionId],
      );
      const log = await superuserPool.query<{ n: number }>("SELECT count(*)::int AS n FROM change_log WHERE workspace_id = $1", [workspaceId]);
      return { payee: row.rows[0]!.payee, memo: row.rows[0]!.memo, changeLogRows: log.rows[0]!.n };
    }

    function upload(changes: { fieldName: string; value: unknown }[]) {
      return app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/changes`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          changes: changes.map((change, counter) => ({
            id: randomUUID(),
            entityId: transactionId,
            fieldName: change.fieldName,
            hlc: { physical: 9_000_000, counter, deviceId: "device-a" },
            value: change.value,
          })),
        },
      });
    }

    it("rejects the whole batch when one change's text is over its limit, applying and recording none of it", async () => {
      const before = await snapshot();
      const response = await upload([
        { fieldName: "transactions.memo", value: "m".repeat(MAX_FREE_TEXT_LENGTH) },
        { fieldName: "transactions.payee", value: "p".repeat(MAX_FREE_TEXT_LENGTH + 1) },
      ]);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "text_too_long", details: { field: "transactions.payee", max: MAX_FREE_TEXT_LENGTH } });
      assert.deepEqual(await snapshot(), before);
    });

    it("rejects the whole batch when a text field's value is neither a string nor null, applying and recording none of it", async () => {
      const before = await snapshot();
      for (const value of [{ x: "m".repeat(MAX_FREE_TEXT_LENGTH + 1) }, ["m"], 42, true]) {
        const response = await upload([
          { fieldName: "transactions.payee", value: "Fine" },
          { fieldName: "transactions.memo", value },
        ]);
        assert.equal(response.statusCode, 400, JSON.stringify(value).slice(0, 20));
        assert.deepEqual(response.json(), { error: "invalid change: transactions.memo takes a string or null" });
      }
      assert.deepEqual(await snapshot(), before);
    });

    it("accepts null and a string at the limit for a text field", async () => {
      const response = await upload([
        { fieldName: "transactions.payee", value: null },
        { fieldName: "transactions.memo", value: "m".repeat(MAX_FREE_TEXT_LENGTH) },
      ]);
      assert.equal(response.statusCode, 201);
      const after = await snapshot();
      assert.equal(after.payee, null);
      assert.equal(after.memo, "m".repeat(MAX_FREE_TEXT_LENGTH));
    });
  });

  describe("entities and change ids outside the workspace (#513)", () => {
    function upload(changes: unknown[]) {
      return app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/changes`,
        headers: { authorization: `Bearer ${token}` },
        payload: { changes },
      });
    }

    function memoChange(id: string, entityId: string, value: string, physical = 20_000_000) {
      return { id, entityId, fieldName: "transactions.memo", hlc: { physical, counter: 0, deviceId: "device-513" }, value };
    }

    async function changeLogRows(changeId: string): Promise<{ workspace_id: string; value: unknown }[]> {
      const { rows } = await superuserPool.query<{ workspace_id: string; value: unknown }>(
        "SELECT workspace_id, value FROM change_log WHERE id = $1",
        [changeId],
      );
      return rows;
    }

    async function memoOf(id: string): Promise<string | null> {
      const { rows } = await superuserPool.query<{ memo: string | null }>("SELECT memo FROM transactions WHERE id = $1", [id]);
      return rows[0]!.memo;
    }

    it("answers not_found for another workspace's transaction and for a random uuid, applying and recording neither", async () => {
      const foreign = memoChange(randomUUID(), otherTransactionId, "overwritten");
      const nowhere = memoChange(randomUUID(), randomUUID(), "nowhere");
      const mine = await newTransaction();
      const fine = memoChange(randomUUID(), mine, "fine");

      const response = await upload([foreign, nowhere, fine]);

      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.json(), {
        results: [
          { id: foreign.id, outcome: "not_found" },
          { id: nowhere.id, outcome: "not_found" },
          { id: fine.id, outcome: "applied" },
        ],
      });
      assert.equal(await memoOf(otherTransactionId), "theirs");
      assert.equal(await memoOf(mine), "fine");
      assert.deepEqual(await changeLogRows(foreign.id), []);
      assert.deepEqual(await changeLogRows(nowhere.id), []);
    });

    it("answers invalid for a change with a malformed id or entity id, and still applies the rest of the batch", async () => {
      const mine = await newTransaction();
      const badId = memoChange("not-a-uuid", mine, "bad id");
      const badEntity = memoChange(randomUUID(), "42", "bad entity");
      const fine = memoChange(randomUUID(), mine, "fine");

      const response = await upload([badId, badEntity, fine]);

      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.json(), {
        results: [
          { id: "not-a-uuid", outcome: "invalid" },
          { id: badEntity.id, outcome: "invalid" },
          { id: fine.id, outcome: "applied" },
        ],
      });
      assert.equal(await memoOf(mine), "fine");
      assert.deepEqual(await changeLogRows(badEntity.id), []);
    });

    it("still refuses the whole batch when a malformed change also carries a non-text value for a text field (#507)", async () => {
      const response = await upload([{ ...memoChange("not-a-uuid", transactionId, "x"), value: { too: "long" } }]);
      assert.equal(response.statusCode, 400);
    });

    it("records a change reusing another workspace's change id as this workspace's own, and never shows the other one", async () => {
      const sharedId = randomUUID();
      await superuserPool.query(
        `INSERT INTO change_log (id, workspace_id, entity_id, field_name, hlc_physical, hlc_counter, device_id, value, outcome)
         VALUES ($1, $2, $3, 'transactions.memo', 1, 0, 'their-device', '"theirs"', 'applied')`,
        [sharedId, otherWorkspaceId, otherTransactionId],
      );
      const mine = await newTransaction();

      const response = await upload([memoChange(sharedId, mine, "mine", 30_000_000)]);

      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.json(), { results: [{ id: sharedId, outcome: "applied" }] }, "the same answer as a fresh id");
      assert.equal(await memoOf(mine), "mine");
      assert.equal(await memoOf(otherTransactionId), "theirs");
      assert.deepEqual(
        (await changeLogRows(sharedId)).map((row) => [row.workspace_id, row.value]).sort(),
        [
          [otherWorkspaceId, "theirs"],
          [workspaceId, "mine"],
        ].sort(),
      );

      const download = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/changes`,
        headers: { authorization: `Bearer ${token}` },
      });
      const listed = (download.json() as { changes: { id: string; entityId: string; value: unknown }[] }).changes.filter(
        (c) => c.id === sharedId,
      );
      assert.deepEqual(listed, [
        {
          id: sharedId,
          entityId: mine,
          fieldName: "transactions.memo",
          hlc: { physical: 30_000_000, counter: 0, deviceId: "device-513" },
          value: "mine",
        },
      ]);
    });

    it("answers a retried upload with each change's original outcome, recording and applying nothing new", async () => {
      const mine = await newTransaction();
      const later = memoChange(randomUUID(), mine, "later", 40_000_002);
      const earlier = memoChange(randomUUID(), mine, "earlier", 40_000_001);

      const first = await upload([later, earlier]);
      const retried = await upload([later, earlier]);

      assert.deepEqual(first.json(), {
        results: [
          { id: later.id, outcome: "applied" },
          { id: earlier.id, outcome: "stale" },
        ],
      });
      assert.deepEqual(retried.json(), first.json());
      assert.equal(await memoOf(mine), "later");
      assert.equal((await changeLogRows(later.id)).length, 1);
      assert.equal((await changeLogRows(earlier.id)).length, 1);
    });

    it("refuses a different change sent under a change id this workspace already used, as id_conflict", async () => {
      const mine = await newTransaction();
      const original = memoChange(randomUUID(), mine, "original", 50_000_000);
      await upload([original]);

      const response = await upload([{ ...original, value: "replaced", hlc: { ...original.hlc, physical: 50_000_001 } }]);

      assert.deepEqual(response.json(), { results: [{ id: original.id, outcome: "id_conflict" }] });
      assert.equal(await memoOf(mine), "original");
      assert.deepEqual(await changeLogRows(original.id), [{ workspace_id: workspaceId, value: "original" }]);
    });
  });
});
