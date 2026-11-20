import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { type App } from "../app.ts";
import { createWorkspaceMembershipPreHandler } from "../auth/workspace-membership.ts";
import { type DbPool } from "../db/pool.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";

const MAPPING = {
  hasHeaderRow: true,
  dateColumn: 0,
  dateFormat: "YYYY-MM-DD",
  descriptionColumn: 1,
  amountColumn: 2,
  decimalSeparator: ".",
};
const CSV = "Date,Description,Amount\n2026-02-01,Groceries,-12.50\n";
const MALFORMED = "not-a-uuid";

/** Words a database error message carries that must never reach a client. */
const LEAKY_WORDS = ["import_mappings", "category_groups", "constraint", "violates", "row-level", "division", "syntax", "secret"];

describe("account ownership and error replies (#512)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  let accountId: string;
  let categoryId: string;
  /** A workspace the user is not a member of, with a real account and a saved import mapping. */
  const foreignWorkspaceId = randomUUID();
  let foreignAccountId: string;
  /** A second account of that workspace, without any mapping: answered exactly like the first. */
  let foreignAccountWithoutMappingId: string;

  const auth = () => ({ authorization: `Bearer ${token}` });

  function inject(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) {
    return app.fastify.inject({ method, url, headers: auth(), ...(payload ? { payload } : {}) });
  }

  /** Every connection the app took for a request has gone back to the pool. */
  function assertNoConnectionCheckedOut(): void {
    assert.equal(app.pool.totalCount - app.pool.idleCount, 0, "a connection is still checked out");
  }

  /** How many times `run` asked the app's pool for a connection (`pool.query` goes through `connect` too). */
  async function connectionsTakenBy(run: () => Promise<unknown>): Promise<number> {
    const pool = app.pool;
    const original = pool.connect;
    let taken = 0;
    pool.connect = function (this: DbPool, ...args: unknown[]) {
      taken += 1;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof pool.connect;
    try {
      await run();
    } finally {
      pool.connect = original;
    }
    return taken;
  }

  function assertNoLeak(body: string): void {
    for (const word of LEAKY_WORDS) {
      assert.ok(!body.toLowerCase().includes(word), `the reply leaks "${word}": ${body}`);
    }
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await superuserPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) AS rows`, params);
    return rows[0]!.n;
  }

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest({
      beforeReady: (built) => registerTestErrorRoutes(built),
    }));

    const account = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    accountId = account.rows[0]!.id;
    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;

    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Foreign', 'EUR', 'Europe/Rome')",
      [foreignWorkspaceId],
    );
    const foreignAccount = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Their checking', 'checking', 'EUR') RETURNING id",
      [foreignWorkspaceId],
    );
    foreignAccountId = foreignAccount.rows[0]!.id;
    const foreignAccountWithoutMapping = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Their savings', 'savings', 'EUR') RETURNING id",
      [foreignWorkspaceId],
    );
    foreignAccountWithoutMappingId = foreignAccountWithoutMapping.rows[0]!.id;
    await superuserPool.query("INSERT INTO import_mappings (account_id, workspace_id, mapping) VALUES ($1, $2, $3)", [
      foreignAccountId,
      foreignWorkspaceId,
      JSON.stringify(MAPPING),
    ]);
  });

  after(async () => {
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [foreignWorkspaceId]);
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  /** Test-only routes that throw on purpose, behind the same membership check as any workspace route. */
  function registerTestErrorRoutes(built: App): void {
    const preHandler = createWorkspaceMembershipPreHandler(built.pool);
    built.fastify.post("/workspaces/:workspaceId/test-errors/:kind", { preHandler }, async (request) => {
      const { kind } = request.params as { kind: string };
      const db = request.db!;
      const ownWorkspaceId = request.workspace!.id;
      // Written first, so each case also proves the request's transaction rolls back.
      await db.query("INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, $2, 99)", [
        ownWorkspaceId,
        `test-errors ${kind}`,
      ]);
      const { foreignAccount, foreignWorkspace } = (request.body ?? {}) as { foreignAccount?: string; foreignWorkspace?: string };
      switch (kind) {
        case "unexpected":
          await db.query("SELECT 1 / 0");
          break;
        case "foreign-key":
          await db.query("INSERT INTO import_mappings (account_id, workspace_id, mapping) VALUES ($1, $2, '{}')", [
            foreignAccount,
            ownWorkspaceId,
          ]);
          break;
        case "rls":
          await db.query("INSERT INTO import_mappings (account_id, workspace_id, mapping) VALUES ($1, $2, '{}')", [
            foreignAccount,
            foreignWorkspace,
          ]);
          break;
        case "invalid-input":
          await db.query("SELECT $1::uuid", ["nope"]);
          break;
        case "thrown":
          throw new Error("secret detail about import_mappings");
      }
      return { ok: true };
    });
  }

  describe("an account of another workspace answers 404 and writes nothing", () => {
    it("PUT import-mapping", async () => {
      for (const id of [foreignAccountId, foreignAccountWithoutMappingId]) {
        const response = await inject("PUT", `/workspaces/${workspaceId}/accounts/${id}/import-mapping`, MAPPING);
        assert.equal(response.statusCode, 404);
        // The same answer whether or not the other workspace saved a mapping for it: nothing to tell apart.
        assert.deepEqual(response.json(), { error: "account not found" });
      }
      assert.equal(await count("SELECT 1 FROM import_mappings WHERE account_id = $1", [foreignAccountWithoutMappingId]), 0);
      assert.equal(await count("SELECT 1 FROM import_mappings WHERE workspace_id = $1", [workspaceId]), 0);
      assertNoConnectionCheckedOut();
    });

    it("GET import-mapping", async () => {
      const response = await inject("GET", `/workspaces/${workspaceId}/accounts/${foreignAccountId}/import-mapping`);
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: "account not found" });
    });

    it("POST import (staging)", async () => {
      for (const format of ["csv", "ofx", "qif", "camt053"]) {
        const response = await inject("POST", `/workspaces/${workspaceId}/accounts/${foreignAccountId}/import`, {
          format,
          content: CSV,
          mapping: MAPPING,
        });
        assert.equal(response.statusCode, 404, format);
      }
      assert.equal(await count("SELECT 1 FROM staged_transactions WHERE account_id = $1", [foreignAccountId]), 0);
      assertNoConnectionCheckedOut();
    });

    it("GET staged-transactions and POST its confirmation", async () => {
      const listed = await inject("GET", `/workspaces/${workspaceId}/accounts/${foreignAccountId}/staged-transactions`);
      assert.equal(listed.statusCode, 404);
      const confirmed = await inject("POST", `/workspaces/${workspaceId}/accounts/${foreignAccountId}/staged-transactions/confirm`, {
        decisions: [{ stagedTransactionId: randomUUID(), kind: "income" }],
      });
      assert.equal(confirmed.statusCode, 404);
    });

    it("GET reconciliation-candidates and POST reconciliations", async () => {
      const candidates = await inject(
        "GET",
        `/workspaces/${workspaceId}/accounts/${foreignAccountId}/reconciliation-candidates?date=2026-02-28`,
      );
      assert.equal(candidates.statusCode, 404);
      const reconciled = await inject("POST", `/workspaces/${workspaceId}/accounts/${foreignAccountId}/reconciliations`, {
        date: "2026-02-28",
        statementBalanceCents: 0,
        tickedTransactionIds: [],
      });
      assert.equal(reconciled.statusCode, 404);
      assert.equal(await count("SELECT 1 FROM reconciliations WHERE account_id = $1", [foreignAccountId]), 0);
      assertNoConnectionCheckedOut();
    });

    it("POST and GET an account's transactions", async () => {
      const created = await inject("POST", `/workspaces/${workspaceId}/accounts/${foreignAccountId}/transactions`, {
        occurredAt: "2026-02-01",
        splits: [{ categoryId, amountCents: -1250 }],
      });
      assert.equal(created.statusCode, 404);
      assert.deepEqual(created.json(), { error: "account not found" });
      const listed = await inject("GET", `/workspaces/${workspaceId}/accounts/${foreignAccountId}/transactions`);
      assert.equal(listed.statusCode, 404);
      assert.equal(await count("SELECT 1 FROM transactions WHERE account_id = $1", [foreignAccountId]), 0);
      assertNoConnectionCheckedOut();
    });

    it("POST scheduled-transactions with the account in its body", async () => {
      const response = await inject("POST", `/workspaces/${workspaceId}/scheduled-transactions`, {
        accountId: foreignAccountId,
        nextDueDate: "2026-03-01",
        recurEvery: 1,
        recurUnit: "month",
        splits: [{ categoryId, amountCents: 90_000 }],
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: "account not found" });
      assert.equal(await count("SELECT 1 FROM scheduled_transactions WHERE workspace_id = $1", [workspaceId]), 0);
      assertNoConnectionCheckedOut();
    });

    it("POST transfers answers its own unknown_account, as before", async () => {
      const response = await inject("POST", `/workspaces/${workspaceId}/transfers`, {
        sourceAccountId: accountId,
        destinationAccountId: foreignAccountId,
        occurredAt: "2026-02-01",
        amountCents: 1000,
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "unknown_account", details: { accountId: foreignAccountId } });
      assert.equal(await count("SELECT 1 FROM transactions WHERE account_id = $1", [accountId]), 0);
    });

    it("still serves the workspace's own account", async () => {
      const saved = await inject("PUT", `/workspaces/${workspaceId}/accounts/${accountId}/import-mapping`, MAPPING);
      assert.equal(saved.statusCode, 200);
      const staged = await inject("GET", `/workspaces/${workspaceId}/accounts/${accountId}/staged-transactions`);
      assert.equal(staged.statusCode, 200);
      await superuserPool.query("DELETE FROM import_mappings WHERE account_id = $1", [accountId]);
    });
  });

  describe("a malformed id answers 404 without reaching the database", () => {
    /**
     * Every workspace route with an id in its path when #512 landed. The check is one global
     * preHandler, so a route added later is covered without being listed here.
     */
    const pathRoutes: [method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string][] = [
      ["PATCH", `/accounts/${MALFORMED}`],
      ["POST", `/accounts/${MALFORMED}/tax-regimes`],
      ["PUT", `/accounts/${MALFORMED}/tax-regimes`],
      ["PUT", `/categories/${MALFORMED}/goal`],
      ["PUT", `/category-groups/${MALFORMED}/categories/reorder`],
      ["PATCH", `/portfolios/${MALFORMED}`],
      ["PUT", `/accounts/${MALFORMED}/import-mapping`],
      ["GET", `/accounts/${MALFORMED}/import-mapping`],
      ["POST", `/accounts/${MALFORMED}/import`],
      ["GET", `/accounts/${MALFORMED}/staged-transactions`],
      ["POST", `/accounts/${MALFORMED}/staged-transactions/confirm`],
      ["GET", `/accounts/${MALFORMED}/reconciliation-candidates?date=2026-02-28`],
      ["POST", `/accounts/${MALFORMED}/reconciliations`],
      ["POST", `/accounts/${MALFORMED}/transactions`],
      ["GET", `/accounts/${MALFORMED}/transactions`],
      ["PATCH", `/accounts/${MALFORMED}/close`],
      ["GET", `/accounts/${MALFORMED}/tax-regimes`],
      ["PATCH", `/accounts/{ACCOUNT}/transactions/${MALFORMED}`],
      ["DELETE", `/accounts/{ACCOUNT}/transactions/${MALFORMED}`],
      ["POST", `/transactions/${MALFORMED}/unlock-reconciliation`],
      ["PATCH", `/scheduled-transactions/${MALFORMED}`],
      ["DELETE", `/scheduled-transactions/${MALFORMED}`],
      ["POST", `/scheduled-transactions/${MALFORMED}/record`],
      ["POST", `/scheduled-transactions/${MALFORMED}/skip`],
      ["PATCH", `/categories/${MALFORMED}`],
      ["PATCH", `/categories/${MALFORMED}/archive`],
      ["GET", `/categories/${MALFORMED}/goal?month=2026-02`],
      ["DELETE", `/categories/${MALFORMED}/goal`],
      ["PATCH", `/category-groups/${MALFORMED}`],
      ["PATCH", `/category-groups/${MALFORMED}/archive`],
      ["POST", `/assignment-batches/${MALFORMED}/undo`],
      ["POST", `/assignments/${MALFORMED}/undo`],
      ["GET", `/portfolios/${MALFORMED}`],
      ["DELETE", `/portfolios/${MALFORMED}`],
    ];

    let baselineConnections: number;

    before(async () => {
      // A request with no workspace still takes the user mapper's own connection: the baseline.
      baselineConnections = await connectionsTakenBy(() => inject("GET", "/me"));
    });

    for (const [method, path] of pathRoutes) {
      it(`${method} ${path}`, async () => {
        const url = `/workspaces/${workspaceId}${path.replace("{ACCOUNT}", accountId)}`;
        let response: Awaited<ReturnType<typeof inject>> | undefined;
        const taken = await connectionsTakenBy(async () => {
          response = await inject(method, url, method === "GET" || method === "DELETE" ? undefined : {});
        });
        assert.equal(response!.statusCode, 404, response!.body);
        assert.match(response!.json().error, / not found$/);
        assert.equal(taken, baselineConnections, "the route took a database connection of its own");
        assertNoConnectionCheckedOut();
      });
    }

    it("counts connections usefully: a well-formed unknown id does take the route's own", async () => {
      const taken = await connectionsTakenBy(() => inject("GET", `/workspaces/${workspaceId}/accounts/${randomUUID()}/transactions`));
      assert.ok(taken > baselineConnections, `${taken} connection(s), baseline ${baselineConnections}`);
    });

    it("still answers 401 first to a request with no token (the check runs after authentication)", async () => {
      const response = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/accounts/${MALFORMED}/transactions`,
      });
      assert.equal(response.statusCode, 401);
    });

    it("GET /instruments/:instrumentId", async () => {
      const response = await inject("GET", `/instruments/${MALFORMED}`);
      assert.equal(response.statusCode, 404);
    });

    it("an account id in a body", async () => {
      const response = await inject("POST", `/workspaces/${workspaceId}/scheduled-transactions`, {
        accountId: MALFORMED,
        nextDueDate: "2026-03-01",
        recurEvery: 1,
        recurUnit: "month",
        splits: [{ categoryId, amountCents: 90_000 }],
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: "account not found" });
    });

    it("a transfer's account, as its own unknown_account", async () => {
      const response = await inject("POST", `/workspaces/${workspaceId}/transfers`, {
        sourceAccountId: accountId,
        destinationAccountId: MALFORMED,
        occurredAt: "2026-02-01",
        amountCents: 1000,
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "unknown_account", details: { accountId: MALFORMED } });
    });

    it("a staged row in a confirmation, as not found", async () => {
      const response = await inject("POST", `/workspaces/${workspaceId}/accounts/${accountId}/staged-transactions/confirm`, {
        decisions: [{ stagedTransactionId: MALFORMED, kind: "income" }],
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { outcomes: [{ stagedTransactionId: MALFORMED, outcome: "not_found" }] });
    });

    it("a malformed workspace id still answers 403, like any workspace the caller is not a member of", async () => {
      const response = await inject("GET", `/workspaces/${MALFORMED}/accounts/${accountId}/transactions`);
      assert.equal(response.statusCode, 403);
    });
  });

  describe("the global error handler", () => {
    async function trigger(kind: string) {
      const response = await inject("POST", `/workspaces/${workspaceId}/test-errors/${kind}`, {
        // The account without a mapping, so the insert reaches the foreign key, not the unique account_id.
        foreignAccount: foreignAccountWithoutMappingId,
        foreignWorkspace: foreignWorkspaceId,
      });
      assertNoLeak(response.body);
      // Nothing the route wrote before failing is kept.
      assert.equal(await count("SELECT 1 FROM category_groups WHERE name = $1", [`test-errors ${kind}`]), 0);
      assertNoConnectionCheckedOut();
      return response;
    }

    it("answers an unexpected database error with a generic 500 and no database message", async () => {
      const response = await trigger("unexpected");
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), { error: "internal_error" });
    });

    it("answers any other thrown error with the same generic 500", async () => {
      const response = await trigger("thrown");
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), { error: "internal_error" });
    });

    it("maps a foreign-key violation to 400 invalid_reference", async () => {
      const response = await trigger("foreign-key");
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "invalid_reference" });
    });

    it("maps a Row-Level Security refusal to 403 forbidden", async () => {
      const response = await trigger("rls");
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.json(), { error: "forbidden" });
    });

    it("maps invalid input syntax to 400 invalid_input", async () => {
      const response = await trigger("invalid-input");
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "invalid_input" });
    });

    it("keeps Fastify's own client errors, without their message", async () => {
      const unsupported = await app.fastify.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/import-mapping`,
        headers: { ...auth(), "content-type": "application/xml" },
        payload: "<mapping/>",
      });
      assert.equal(unsupported.statusCode, 415);
      assert.equal(unsupported.json().error, "unsupported_media_type");

      const badJson = await app.fastify.inject({
        method: "PUT",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/import-mapping`,
        headers: { ...auth(), "content-type": "application/json" },
        payload: "{not json",
      });
      assert.equal(badJson.statusCode, 400);
      assert.equal(badJson.json().error, "bad_request");
      assertNoConnectionCheckedOut();
    });
  });
});
