/**
 * Idempotent creates over the routes (#559, ADR 0020): the `Idempotency-Key` header on every route
 * that takes it, the client's `batchId` on assignments and quick assign, the header refused where
 * it is not taken, a key in another workspace, and a real concurrent double submit.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { decodeJwt } from "jose";

import { type App } from "../app.ts";
import { createWorkspaceMembershipPreHandler, withWriteAccess } from "../auth/workspace-membership.ts";
import { type DbPool } from "../db/pool.ts";
import { IDEMPOTENT_ROUTE, withIdempotencyKey } from "../idempotency/route.ts";
import type { QueueDriver } from "../queue/index.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";

/** Counts what the write paths enqueue; runs nothing. */
function countingQueue(): QueueDriver & { enqueued: string[] } {
  const enqueued: string[] = [];
  return {
    enqueued,
    enqueue: async (jobType) => {
      enqueued.push(jobType);
      return randomUUID();
    },
    schedule: async () => {},
    work: async () => {},
    start: async () => {},
    stop: async () => {},
  };
}

describe("idempotent creates (#559)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  let userId: string;
  let accountId: string;
  let savingsAccountId: string;
  let categoryId: string;
  let groupId: string;
  let otherMemberToken: string;
  let otherWorkspaceId: string;
  let otherAccountId: string;
  let otherCategoryId: string;
  const queue = countingQueue();

  async function insertId(sql: string, params: unknown[]): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(`${sql} RETURNING id`, params);
    return rows[0]!.id;
  }

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest({
      queue,
      beforeReady: (built) => {
        const preHandler = withWriteAccess(createWorkspaceMembershipPreHandler(built.pool));
        // A route that claims a key and replies 201 without storing the reply: the onSend check
        // must refuse it (500), and nothing may be committed.
        built.fastify.post(
          "/workspaces/:workspaceId/test-unstored-reply",
          { preHandler, config: IDEMPOTENT_ROUTE },
          withIdempotencyKey(async (request, reply) => {
            await request.db!.query("INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Unstored', 99)", [
              request.workspace!.id,
            ]);
            await reply.code(201).send({ ok: true });
          }),
        );
        // A route that claims a key, then claims to have stored the reply without storing it: only
        // the deferred trigger of migration 0039 is left to refuse the commit.
        built.fastify.post(
          "/workspaces/:workspaceId/test-unstored-reply-past-the-check",
          { preHandler, config: IDEMPOTENT_ROUTE },
          withIdempotencyKey(async (request, reply) => {
            request.idempotencyKey!.stored = true;
            await reply.code(201).send({ ok: true });
          }),
        );
      },
    }));
    userId = (
      await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [decodeJwt(token).sub])
    ).rows[0]!.id;

    accountId = await insertId("INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR')", [
      workspaceId,
    ]);
    savingsAccountId = await insertId(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Savings', 'savings', 'EUR')",
      [workspaceId],
    );
    groupId = await insertId("INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1)", [workspaceId]);
    categoryId = await insertId(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1)",
      [workspaceId, groupId],
    );

    // A second member of the same workspace.
    otherMemberToken = await realm.getTokenForNewUser();
    await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${otherMemberToken}` } });
    const otherUser = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      decodeJwt(otherMemberToken).sub,
    ]);
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'editor')", [
      otherUser.rows[0]!.id,
      workspaceId,
    ]);

    // A second workspace, of which the same user is also the owner.
    otherWorkspaceId = randomUUID();
    await superuserPool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Other', 'EUR', 'Europe/Rome')", [
      otherWorkspaceId,
    ]);
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [userId, otherWorkspaceId]);
    otherAccountId = await insertId(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Their checking', 'checking', 'EUR')",
      [otherWorkspaceId],
    );
    const otherGroupId = await insertId("INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1)", [
      otherWorkspaceId,
    ]);
    otherCategoryId = await insertId(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1)",
      [otherWorkspaceId, otherGroupId],
    );
  });

  after(async () => {
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [otherWorkspaceId]);
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  function headers(key?: string, bearer = token): Record<string, string> {
    return { authorization: `Bearer ${bearer}`, ...(key !== undefined ? { "idempotency-key": key } : {}) };
  }

  function transactionBody(payee: string, amountCents = -1250): Record<string, unknown> {
    return { occurredAt: "2026-09-10", payee, splits: [{ categoryId, amountCents }] };
  }

  async function postTransaction(key: string | undefined, body: unknown, options: { bearer?: string; account?: string; workspace?: string } = {}) {
    return app.fastify.inject({
      method: "POST",
      url: `/workspaces/${options.workspace ?? workspaceId}/accounts/${options.account ?? accountId}/transactions`,
      headers: headers(key, options.bearer),
      payload: body as Record<string, unknown>,
    });
  }

  async function countRows(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await superuserPool.query<{ count: string }>(sql, params);
    return Number(rows[0]!.count);
  }

  const transactionsWithPayee = (payee: string): Promise<number> =>
    countRows("SELECT count(*) FROM transactions WHERE payee = $1", [payee]);
  const storedKeys = (key: string): Promise<number> => countRows("SELECT count(*) FROM idempotency_keys WHERE key = $1", [key]);

  describe("creating a transaction", () => {
    it("records once and replays the stored reply, marked as replayed, for the same key and body", async () => {
      const key = randomUUID();
      const payee = `Replay ${key}`;
      const enqueuedBefore = queue.enqueued.length;
      const first = await postTransaction(key, transactionBody(payee));
      assert.equal(first.statusCode, 201, first.body);
      assert.equal(first.headers["idempotent-replayed"], undefined);

      const second = await postTransaction(key, transactionBody(payee));
      assert.equal(second.statusCode, 201);
      assert.equal(second.headers["idempotent-replayed"], "true");
      assert.deepEqual(second.json(), first.json());
      assert.equal(await transactionsWithPayee(payee), 1);
      assert.equal(queue.enqueued.length - enqueuedBefore, 1, "a replay enqueues nothing");
    });

    it("replays whatever the key's letter case, and whatever the order of the body's keys", async () => {
      const key = randomUUID();
      const payee = `Case ${key}`;
      const first = await postTransaction(key, { occurredAt: "2026-09-10", payee, splits: [{ categoryId, amountCents: -100 }] });
      assert.equal(first.statusCode, 201);
      const second = await postTransaction(key.toUpperCase(), { splits: [{ amountCents: -100, categoryId }], payee, occurredAt: "2026-09-10" });
      assert.equal(second.statusCode, 201);
      assert.equal(second.headers["idempotent-replayed"], "true");
      assert.equal(second.json().id, first.json().id);
      assert.equal(await transactionsWithPayee(payee), 1);
    });

    it("refuses the same key with another body as id_conflict, writing nothing", async () => {
      const key = randomUUID();
      const payee = `Conflict ${key}`;
      assert.equal((await postTransaction(key, transactionBody(payee))).statusCode, 201);
      const other = await postTransaction(key, transactionBody(payee, -999));
      assert.equal(other.statusCode, 409);
      assert.deepEqual(other.json(), { error: "id_conflict", details: { field: "Idempotency-Key" } });
      assert.equal(await transactionsWithPayee(payee), 1);
    });

    it("refuses the same key on another account of the workspace as id_conflict", async () => {
      const key = randomUUID();
      const payee = `Other account ${key}`;
      assert.equal((await postTransaction(key, transactionBody(payee))).statusCode, 201);
      const other = await postTransaction(key, transactionBody(payee), { account: savingsAccountId });
      assert.equal(other.statusCode, 409);
      assert.equal(other.json().error, "id_conflict");
    });

    it("refuses the same key from another member of the workspace as id_conflict", async () => {
      const key = randomUUID();
      const payee = `Member ${key}`;
      assert.equal((await postTransaction(key, transactionBody(payee))).statusCode, 201);
      const other = await postTransaction(key, transactionBody(payee), { bearer: otherMemberToken });
      assert.equal(other.statusCode, 409);
      assert.deepEqual(other.json(), { error: "id_conflict", details: { field: "Idempotency-Key" } });
      assert.equal(await transactionsWithPayee(payee), 1);
    });

    it("remembers only a success: a refused request under a key can be corrected and retried under it", async () => {
      const key = randomUUID();
      const payee = `Retry ${key}`;
      const refused = await postTransaction(key, { occurredAt: "2026-02-30", payee, splits: [{ categoryId, amountCents: -100 }] });
      assert.equal(refused.statusCode, 400);
      assert.equal(await storedKeys(key), 0);
      const corrected = await postTransaction(key, transactionBody(payee));
      assert.equal(corrected.statusCode, 201);
      assert.equal(corrected.headers["idempotent-replayed"], undefined);
      assert.equal(await transactionsWithPayee(payee), 1);
    });

    it("still replays the stored reply after the transaction was deleted", async () => {
      const key = randomUUID();
      const payee = `Deleted ${key}`;
      const first = await postTransaction(key, transactionBody(payee));
      assert.equal(first.statusCode, 201);
      const deleted = await app.fastify.inject({
        method: "DELETE",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions/${first.json().id}`,
        headers: headers(),
      });
      assert.equal(deleted.statusCode, 204);
      const again = await postTransaction(key, transactionBody(payee));
      assert.equal(again.statusCode, 201);
      assert.equal(again.headers["idempotent-replayed"], "true");
      assert.deepEqual(again.json(), first.json());
      assert.equal(await transactionsWithPayee(payee), 0, "a replay never writes the transaction again");
    });

    it("treats an expired key as new", async () => {
      const key = randomUUID();
      const payee = `Expired ${key}`;
      const first = await postTransaction(key, transactionBody(payee));
      assert.equal(first.statusCode, 201);
      await superuserPool.query("UPDATE idempotency_keys SET created_at = now() - interval '24 hours 1 minute' WHERE key = $1", [key]);
      const again = await postTransaction(key, transactionBody(payee));
      assert.equal(again.statusCode, 201);
      assert.equal(again.headers["idempotent-replayed"], undefined);
      assert.notEqual(again.json().id, first.json().id);
      assert.equal(await transactionsWithPayee(payee), 2);
      assert.equal(await storedKeys(key), 1);
    });

    it("keeps a key still within its lifetime", async () => {
      const key = randomUUID();
      const payee = `Not expired ${key}`;
      assert.equal((await postTransaction(key, transactionBody(payee))).statusCode, 201);
      await superuserPool.query("UPDATE idempotency_keys SET created_at = now() - interval '23 hours 59 minutes' WHERE key = $1", [key]);
      const again = await postTransaction(key, transactionBody(payee));
      assert.equal(again.headers["idempotent-replayed"], "true");
      assert.equal(await transactionsWithPayee(payee), 1);
    });

    it("refuses a key that is not one UUID as invalid_field, a repeated header included", async () => {
      for (const key of ["not-a-uuid", "", `${randomUUID()}, ${randomUUID()}`, `${randomUUID()}x`]) {
        const response = await postTransaction(key, transactionBody(`Bad key ${randomUUID()}`));
        assert.equal(response.statusCode, 400, key);
        assert.deepEqual(response.json(), { error: "invalid_field", details: { field: "Idempotency-Key" } }, key);
      }
      const repeated = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": [randomUUID(), randomUUID()] },
        payload: transactionBody(`Repeated ${randomUUID()}`),
      });
      assert.equal(repeated.statusCode, 400);
      assert.deepEqual(repeated.json(), { error: "invalid_field", details: { field: "Idempotency-Key" } });
    });

    it("refuses a body nested too deeply to fingerprint as a 400, not a 500", async () => {
      const key = randomUUID();
      // Written by hand: JSON.stringify itself would overflow on a value this deep.
      const depth = 50_000;
      const response = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
        headers: { ...headers(key), "content-type": "application/json" },
        payload: `{"occurredAt":"2026-09-10","splits":[{"categoryId":"${categoryId}","amountCents":-1}],"memo":${"[".repeat(depth)}1${"]".repeat(depth)}}`,
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "invalid_body", details: {} });
      assert.equal(await storedKeys(key), 0);
    });

    it("refuses a number JSON reads as infinite as a 400", async () => {
      const key = randomUUID();
      const response = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
        headers: { ...headers(key), "content-type": "application/json" },
        payload: `{"occurredAt":"2026-09-10","splits":[{"categoryId":"${categoryId}","amountCents":-1}],"extra":1e400}`,
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "invalid_body", details: {} });
    });

    it("never reaches the key with a body carrying __proto__: the JSON parser refuses it first", async () => {
      const key = randomUUID();
      const response = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
        headers: { ...headers(key), "content-type": "application/json" },
        payload: `{"occurredAt":"2026-09-10","splits":[{"categoryId":"${categoryId}","amountCents":-1}],"__proto__":{"x":1}}`,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(await storedKeys(key), 0);
    });

    it("answers a read-only member's key with 403 and keeps nothing", async () => {
      const readOnlyToken = await realm.getTokenForNewUser();
      await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${readOnlyToken}` } });
      const reader = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
        decodeJwt(readOnlyToken).sub,
      ]);
      await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'read_only')", [
        reader.rows[0]!.id,
        workspaceId,
      ]);
      const key = randomUUID();
      const response = await postTransaction(key, transactionBody(`Reader ${key}`), { bearer: readOnlyToken });
      assert.equal(response.statusCode, 403);
      assert.equal(await storedKeys(key), 0);
    });
  });

  describe("another workspace", () => {
    it("records afresh with a key and body another workspace already used, replaying nothing of it", async () => {
      const key = randomUUID();
      const payee = `Shared key ${key}`;
      const mine = await postTransaction(key, transactionBody(payee));
      assert.equal(mine.statusCode, 201);
      const theirs = await postTransaction(
        key,
        { occurredAt: "2026-09-10", payee, splits: [{ categoryId: otherCategoryId, amountCents: -1250 }] },
        { workspace: otherWorkspaceId, account: otherAccountId },
      );
      assert.equal(theirs.statusCode, 201, theirs.body);
      assert.equal(theirs.headers["idempotent-replayed"], undefined);
      assert.notEqual(theirs.json().id, mine.json().id);
      assert.equal(theirs.json().workspaceId, otherWorkspaceId);
      assert.equal(await storedKeys(key), 2, "one key per workspace");
    });

    it("refuses a body sent to the other workspace's account through this workspace, before any key is kept", async () => {
      const key = randomUUID();
      const response = await postTransaction(key, transactionBody(`Foreign account ${key}`), { account: otherAccountId });
      assert.equal(response.statusCode, 404);
      assert.equal(await storedKeys(key), 0);
    });
  });

  describe("creating a transfer", () => {
    it("records both legs once and replays them for the same key and body", async () => {
      const key = randomUUID();
      const payee = `Transfer ${key}`;
      const body = { sourceAccountId: accountId, destinationAccountId: savingsAccountId, occurredAt: "2026-09-11", amountCents: 5000, payee };
      const send = (payload: Record<string, unknown>) =>
        app.fastify.inject({ method: "POST", url: `/workspaces/${workspaceId}/transfers`, headers: headers(key), payload });
      const first = await send(body);
      assert.equal(first.statusCode, 201, first.body);
      const second = await send(body);
      assert.equal(second.statusCode, 201);
      assert.equal(second.headers["idempotent-replayed"], "true");
      assert.deepEqual(second.json(), first.json());
      assert.equal(await transactionsWithPayee(payee), 2, "two legs, once");

      const other = await send({ ...body, amountCents: 5001 });
      assert.equal(other.statusCode, 409);
      assert.deepEqual(other.json(), { error: "id_conflict", details: { field: "Idempotency-Key" } });
      assert.equal(await transactionsWithPayee(payee), 2);
    });
  });

  describe("an assignment batch", () => {
    const entries = () => [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 700 }];
    const batchRows = (batchId: string, workspace = workspaceId): Promise<number> =>
      countRows("SELECT count(*) FROM assignment_ledger WHERE workspace_id = $1 AND batch_id = $2", [workspace, batchId]);
    const post = (payload: Record<string, unknown>, key?: string, workspace = workspaceId) =>
      app.fastify.inject({ method: "POST", url: `/workspaces/${workspace}/assignments`, headers: headers(key), payload });

    it("replays under an Idempotency-Key, appending nothing", async () => {
      const key = randomUUID();
      const first = await post({ entries: entries() }, key);
      assert.equal(first.statusCode, 201, first.body);
      const second = await post({ entries: entries() }, key);
      assert.equal(second.headers["idempotent-replayed"], "true");
      assert.deepEqual(second.json(), first.json());
      assert.equal(await batchRows(first.json().entries[0].batchId), 1);
    });

    it("uses the client's batchId, replays the same entries, and refuses others as id_conflict", async () => {
      const batchId = randomUUID();
      const many = [
        { month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 300 },
        { month: "2026-10", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 200 },
        { month: "2026-11", sourceCategoryId: categoryId, destinationCategoryId: null, amountCents: 100 },
      ];
      const first = await post({ batchId, entries: many });
      assert.equal(first.statusCode, 201, first.body);
      assert.deepEqual(
        first.json().entries.map((e: { batchId: string }) => e.batchId),
        [batchId, batchId, batchId],
      );

      const second = await post({ entries: many, batchId: batchId.toUpperCase() });
      assert.equal(second.statusCode, 201);
      assert.equal(second.headers["idempotent-replayed"], "true");
      assert.deepEqual(second.json(), first.json(), "the same rows, in the request's order");
      assert.equal(await batchRows(batchId), 3);

      const other = await post({ batchId, entries: many.slice(1) });
      assert.equal(other.statusCode, 409);
      assert.deepEqual(other.json(), { error: "id_conflict", details: { field: "batchId", batchId } });
      assert.equal(await batchRows(batchId), 3);
    });

    it("refuses another member's batch under the same id as id_conflict", async () => {
      const batchId = randomUUID();
      assert.equal((await post({ batchId, entries: entries() })).statusCode, 201);
      const theirs = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/assignments`,
        headers: headers(undefined, otherMemberToken),
        payload: { batchId, entries: entries() },
      });
      assert.equal(theirs.statusCode, 409);
      assert.equal(theirs.json().error, "id_conflict");
      assert.equal(await batchRows(batchId), 1);
    });

    it("refuses a batchId the server made, or one an undo made, as id_conflict", async () => {
      const created = await post({ entries: entries() });
      const serverBatchId = created.json().entries[0].batchId;
      const reused = await post({ batchId: serverBatchId, entries: entries() });
      assert.equal(reused.statusCode, 409);
      assert.deepEqual(reused.json(), { error: "id_conflict", details: { field: "batchId", batchId: serverBatchId } });

      const undone = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/assignment-batches/${serverBatchId}/undo`,
        headers: headers(),
      });
      const undoBatchId = undone.json().entries[0].batchId;
      assert.equal((await post({ batchId: undoBatchId, entries: entries() })).statusCode, 409);
    });

    it("refuses a batchId that is not a UUID as invalid_field", async () => {
      const response = await post({ batchId: "batch-1", entries: entries() });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "invalid_field", details: { field: "batchId" } });
    });

    it("frees a batchId whose request was refused, so a corrected one can use it", async () => {
      const batchId = randomUUID();
      const refused = await post({ batchId, entries: [{ ...entries()[0]!, destinationCategoryId: randomUUID() }] });
      assert.equal(refused.statusCode, 400);
      const corrected = await post({ batchId, entries: entries() });
      assert.equal(corrected.statusCode, 201);
      assert.equal(corrected.headers["idempotent-replayed"], undefined);
    });

    it("appends in both workspaces under the same batchId", async () => {
      const batchId = randomUUID();
      assert.equal((await post({ batchId, entries: entries() })).statusCode, 201);
      const theirs = await post(
        { batchId, entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: otherCategoryId, amountCents: 700 }] },
        undefined,
        otherWorkspaceId,
      );
      assert.equal(theirs.statusCode, 201, theirs.body);
      assert.equal(theirs.headers["idempotent-replayed"], undefined);
      assert.equal(await batchRows(batchId), 1);
      assert.equal(await batchRows(batchId, otherWorkspaceId), 1);
    });

    it("replays an undo of a batch under an Idempotency-Key", async () => {
      const created = await post({ entries: entries() });
      const batchId = created.json().entries[0].batchId;
      const key = randomUUID();
      const undo = () =>
        app.fastify.inject({ method: "POST", url: `/workspaces/${workspaceId}/assignment-batches/${batchId}/undo`, headers: headers(key) });
      const first = await undo();
      assert.equal(first.statusCode, 201);
      assert.equal(first.json().entries.length, 1);
      const second = await undo();
      assert.equal(second.headers["idempotent-replayed"], "true");
      assert.deepEqual(second.json(), first.json(), "the same reversal, not an empty second undo");
    });

    it("replays an undo of a single entry under an Idempotency-Key, instead of answering already undone", async () => {
      const created = await post({ entries: entries() });
      const entryId = created.json().entries[0].id;
      const key = randomUUID();
      const undo = () =>
        app.fastify.inject({ method: "POST", url: `/workspaces/${workspaceId}/assignments/${entryId}/undo`, headers: headers(key) });
      const first = await undo();
      assert.equal(first.statusCode, 201);
      const second = await undo();
      assert.equal(second.statusCode, 201);
      assert.deepEqual(second.json(), first.json());
    });
  });

  describe("quick assign", () => {
    const run = (payload: Record<string, unknown>, key?: string) =>
      app.fastify.inject({ method: "POST", url: `/workspaces/${workspaceId}/quick-assign`, headers: headers(key), payload });

    before(async () => {
      // Income to assign, and last month's assignment for "repeat_assigned" to repeat.
      await postTransaction(undefined, { occurredAt: "2026-06-01", payee: "Quick assign income", splits: [{ categoryId: null, amountCents: 1_000_000 }] });
      await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/assignments`,
        headers: headers(),
        payload: { entries: [{ month: "2026-06", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 4_000 }] },
      });
    });

    const assignedInJuly = (): Promise<number> =>
      countRows("SELECT count(*) FROM assignment_ledger WHERE workspace_id = $1 AND month = '2026-07-01'", [workspaceId]);

    it("repeats last month once under an Idempotency-Key", async () => {
      const key = randomUUID();
      const body = { month: "2026-07", mode: "repeat_assigned", scope: { kind: "all" } };
      const before = await assignedInJuly();
      const first = await run(body, key);
      assert.equal(first.statusCode, 201, first.body);
      assert.equal(first.json().entries.length, 1);
      const second = await run(body, key);
      assert.equal(second.headers["idempotent-replayed"], "true");
      assert.deepEqual(second.json(), first.json());
      assert.equal(await assignedInJuly(), before + 1);
    });

    it("repeats last month once under the client's batchId, and refuses another mode under it", async () => {
      const batchId = randomUUID();
      const body = { month: "2026-07", mode: "repeat_assigned", scope: { kind: "group", groupId }, batchId };
      const before = await assignedInJuly();
      const first = await run(body);
      assert.equal(first.statusCode, 201, first.body);
      assert.equal(first.json().entries[0].batchId, batchId);
      const second = await run(body);
      assert.equal(second.statusCode, 201);
      assert.equal(second.headers["idempotent-replayed"], "true");
      assert.deepEqual(second.json(), first.json());
      assert.equal(await assignedInJuly(), before + 1);

      const other = await run({ ...body, mode: "repeat_spent" });
      assert.equal(other.statusCode, 409);
      assert.deepEqual(other.json(), { error: "id_conflict", details: { field: "batchId", batchId } });
    });
  });

  describe("recording a scheduled transaction", () => {
    it("records the occurrence once under an Idempotency-Key, instead of the next one too", async () => {
      const created = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/scheduled-transactions`,
        headers: headers(),
        payload: {
          accountId,
          payee: "Scheduled once",
          nextDueDate: "2026-09-01",
          recurEvery: 1,
          recurUnit: "month",
          splits: [{ categoryId, amountCents: 3_000 }],
        },
      });
      assert.equal(created.statusCode, 201, created.body);
      const key = randomUUID();
      const record = () =>
        app.fastify.inject({
          method: "POST",
          url: `/workspaces/${workspaceId}/scheduled-transactions/${created.json().id}/record`,
          headers: headers(key),
        });
      const first = await record();
      assert.equal(first.statusCode, 201, first.body);
      const second = await record();
      assert.equal(second.headers["idempotent-replayed"], "true");
      assert.deepEqual(second.json(), first.json());
      assert.equal(await transactionsWithPayee("Scheduled once"), 1);
    });
  });

  describe("routes that do not take the header", () => {
    it("refuses it on a write route as invalid_field, before anything is written", async () => {
      const key = randomUUID();
      const created = await postTransaction(undefined, transactionBody(`Patch target ${key}`));
      const patched = await app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions/${created.json().id}`,
        headers: headers(key),
        payload: { memo: "edited" },
      });
      assert.equal(patched.statusCode, 400);
      assert.deepEqual(patched.json(), { error: "invalid_field", details: { field: "Idempotency-Key" } });

      const account = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts`,
        headers: headers(key),
        payload: { name: `Refused ${key}`, type: "cash", currency: "EUR" },
      });
      assert.equal(account.statusCode, 400);
      assert.deepEqual(account.json(), { error: "invalid_field", details: { field: "Idempotency-Key" } });
      assert.equal(await countRows("SELECT count(*) FROM accounts WHERE name = $1", [`Refused ${key}`]), 0);

      const workspace = await app.fastify.inject({ method: "POST", url: "/workspaces", headers: headers(key), payload: { name: "Refused" } });
      assert.equal(workspace.statusCode, 400);
    });

    it("ignores it on a read", async () => {
      const response = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
        headers: headers("not even a uuid"),
      });
      assert.equal(response.statusCode, 200);
    });
  });

  describe("a route that does not store its reply", () => {
    it("fails with 500 and commits nothing, the key included", async () => {
      const key = randomUUID();
      const response = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/test-unstored-reply`,
        headers: headers(key),
        payload: {},
      });
      assert.equal(response.statusCode, 500);
      assert.equal(await storedKeys(key), 0);
      assert.equal(await countRows("SELECT count(*) FROM category_groups WHERE workspace_id = $1 AND name = 'Unstored'", [workspaceId]), 0);
    });

    it("is refused at commit by the database when it gets past the check", async () => {
      const key = randomUUID();
      const response = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/test-unstored-reply-past-the-check`,
        headers: headers(key),
        payload: {},
      });
      assert.equal(response.statusCode, 500);
      assert.equal(await storedKeys(key), 0);
    });
  });

  describe("two requests with the same key at once, over real HTTP connections", () => {
    let baseUrl: string;

    before(async () => {
      const address = await app.fastify.listen({ host: "127.0.0.1", port: 0 });
      baseUrl = address;
    });

    /** Polls until `ready` holds, failing after a few seconds. */
    async function until(what: string, ready: () => Promise<boolean>): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (!(await ready())) {
        if (Date.now() >= deadline) {
          const { rows } = await superuserPool.query(
            "SELECT pid, state, wait_event_type, pg_blocking_pids(pid) AS blocked_by, left(query, 80) AS query FROM pg_stat_activity WHERE datname = current_database()",
          );
          assert.fail(`timed out waiting for ${what}: ${JSON.stringify(rows)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    async function blockedBy(pid: number, table: string): Promise<number[]> {
      const { rows } = await superuserPool.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid)) AND query ILIKE $2",
        [pid, `%${table}%`],
      );
      return rows.map((row) => row.pid);
    }

    it("records once: the second waits on the first's key, then replays its reply", async () => {
      const key = randomUUID();
      const payee = `Concurrent ${key}`;
      const enqueuedBefore = queue.enqueued.length;
      const send = (): Promise<Response> =>
        fetch(`${baseUrl}/workspaces/${workspaceId}/accounts/${accountId}/transactions`, {
          method: "POST",
          headers: { ...headers(key), "content-type": "application/json" },
          body: JSON.stringify(transactionBody(payee)),
        });

      // A third connection holds the account row: request 1 claims the key, then waits in the
      // closed-account trigger's FOR KEY SHARE on the account.
      const holder = await superuserPool.connect();
      let first: Promise<Response> | undefined;
      let second: Promise<Response> | undefined;
      try {
        await holder.query("BEGIN");
        const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const holderPid = rows[0]!.pid;
        await holder.query("SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE", [accountId]);

        first = send();
        let firstPid = 0;
        await until("request 1 to wait on the account", async () => {
          const waiting = await blockedBy(holderPid, "transactions");
          firstPid = waiting[0] ?? 0;
          return waiting.length === 1;
        });

        // Request 2 waits on request 1's uncommitted key, holding nothing else.
        second = send();
        await until("request 2 to wait on request 1's key", async () => (await blockedBy(firstPid, "idempotency_keys")).length === 1);
        await holder.query("COMMIT");
      } finally {
        holder.release();
      }

      const [a, b] = await Promise.all([first!, second!]);
      assert.equal(a.status, 201);
      assert.equal(b.status, 201);
      const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);
      assert.deepEqual(bodyB, bodyA);
      assert.equal(a.headers.get("idempotent-replayed"), null);
      assert.equal(b.headers.get("idempotent-replayed"), "true");
      assert.equal(await transactionsWithPayee(payee), 1);
      assert.equal(queue.enqueued.length - enqueuedBefore, 1, "one budget-recompute job");
      assert.equal(await storedKeys(key), 1);
    });

    it("creates in the second when the first is refused and rolls back", async () => {
      const key = randomUUID();
      const payee = `Concurrent rollback ${key}`;
      // Request 1 names an account the holder closes before letting it go: request 1 is refused
      // (account_closed) and rolls its key back; request 2, waiting on that key, then claims it,
      // and is refused for the same reason, which proves it ran instead of replaying.
      const closable = await insertId(
        "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Closable', 'checking', 'EUR')",
        [workspaceId],
      );
      const send = (): Promise<Response> =>
        fetch(`${baseUrl}/workspaces/${workspaceId}/accounts/${closable}/transactions`, {
          method: "POST",
          headers: { ...headers(key), "content-type": "application/json" },
          body: JSON.stringify(transactionBody(payee)),
        });
      const holder = await superuserPool.connect();
      let first: Promise<Response> | undefined;
      let second: Promise<Response> | undefined;
      try {
        await holder.query("BEGIN");
        const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const holderPid = rows[0]!.pid;
        // As closing does (migration 0033): FOR UPDATE, which the trigger's FOR KEY SHARE waits on.
        await holder.query("SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE", [closable]);
        await holder.query("UPDATE accounts SET closed_at = now() WHERE id = $1", [closable]);

        first = send();
        let firstPid = 0;
        await until("request 1 to wait on the account", async () => {
          const waiting = await blockedBy(holderPid, "transactions");
          firstPid = waiting[0] ?? 0;
          return waiting.length === 1;
        });
        second = send();
        await until("request 2 to wait on request 1's key", async () => (await blockedBy(firstPid, "idempotency_keys")).length === 1);
        await holder.query("COMMIT");
      } finally {
        holder.release();
      }

      const [a, b] = await Promise.all([first!, second!]);
      assert.equal(a.status, 409);
      assert.equal(b.status, 409);
      assert.equal(((await b.json()) as { error: string }).error, "account_closed", "request 2 ran the request itself");
      assert.equal(await storedKeys(key), 0);
    });
  });
});
