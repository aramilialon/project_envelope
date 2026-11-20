import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { ValidationError } from "@envelope/core";
import Fastify, { type FastifyInstance } from "fastify";
import { decodeJwt } from "jose";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { sendIfValidationError } from "../errors.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { createAuthPreHandler, createTokenVerifier } from "./token-verifier.ts";
import { createUserMapperPreHandler } from "./user-mapper.ts";
import { createWorkspaceMembershipPreHandler, registerWorkspaceScope } from "./workspace-membership.ts";

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

describe("workspace membership, chained after auth and user mapping", () => {
  let pool: DbPool;
  let realm: KeycloakTestRealm;
  let app: FastifyInstance;
  let memberWorkspaceId: string;
  let otherWorkspaceId: string;
  let createdUserId: string | undefined;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    realm = await setUpKeycloakTestRealm();

    const verifier = createTokenVerifier({ keycloakIssuer: realm.issuer, keycloakAudience: realm.audience });
    const preHandlers = [
      createAuthPreHandler(verifier),
      createUserMapperPreHandler(pool),
      createWorkspaceMembershipPreHandler(pool),
    ];

    app = Fastify();
    registerWorkspaceScope(app);
    app.get("/workspaces/:workspaceId/ping", { preHandler: preHandlers }, async (request) => {
      const { rows } = await request.db!.query<{ user_id: string; workspace_id: string }>(
        "SELECT current_setting('app.user_id', true) AS user_id, current_setting('app.workspace_id', true) AS workspace_id",
      );
      return { role: request.workspace?.role, guc: rows[0] };
    });
    app.get("/workspace-ping-by-header", { preHandler: preHandlers }, async (request) => ({
      role: request.workspace?.role,
    }));

    // Fixture data, set up directly with the pool (superuser, bypasses RLS): not under test here.
    memberWorkspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Mine', 'EUR', 'Europe/Rome')",
      [memberWorkspaceId],
    );
    await pool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Not mine', 'EUR', 'Europe/Rome')",
      [otherWorkspaceId],
    );
  });

  after(async () => {
    await app.close();
    await pool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[memberWorkspaceId, otherWorkspaceId]]);
    if (createdUserId) {
      await pool.query("DELETE FROM users WHERE id = $1", [createdUserId]);
    }
    await realm.teardown();
    await pool.end();
  });

  async function localUserIdFor(token: string): Promise<string> {
    const subject = decodeJwt(token).sub;
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [subject]);
    const id = rows[0]?.id;
    assert.ok(id, "expected the user mapper to have created a local user for this token's subject");
    return id;
  }

  it("a member of the workspace proceeds, with the role available and the GUCs set", async () => {
    const token = await realm.getUserToken();

    // First call: no membership yet, so 403 — but auth and user mapping already ran and created the local user.
    const before = await app.inject({
      method: "GET",
      url: `/workspaces/${memberWorkspaceId}/ping`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(before.statusCode, 403);

    const userId = await localUserIdFor(token);
    createdUserId = userId;
    await pool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [
      userId,
      memberWorkspaceId,
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/workspaces/${memberWorkspaceId}/ping`,
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.role, "owner");
    assert.equal(body.guc.user_id, userId);
    assert.equal(body.guc.workspace_id, memberWorkspaceId);
  });

  it("a non-member gets 403", async () => {
    const token = await realm.getUserToken();
    const response = await app.inject({
      method: "GET",
      url: `/workspaces/${otherWorkspaceId}/ping`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 403);
  });

  it("accepts the workspace id from a header when there is no route param", async () => {
    const token = await realm.getUserToken();
    const response = await app.inject({
      method: "GET",
      url: "/workspace-ping-by-header",
      headers: { authorization: `Bearer ${token}`, "x-workspace-id": memberWorkspaceId },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().role, "owner");
  });

  it("rejects a request with no workspace id at all", async () => {
    const token = await realm.getUserToken();
    const response = await app.inject({
      method: "GET",
      url: "/workspace-ping-by-header",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 400);
  });

  it("answers 403 to a malformed workspace id without holding a connection", async () => {
    const token = await realm.getUserToken();
    for (const [url, headers] of [
      ["/workspaces/not-a-uuid/ping", {}],
      ["/workspace-ping-by-header", { "x-workspace-id": "not-a-uuid" }],
    ] as const) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}`, ...headers },
      });
      assert.equal(response.statusCode, 403);
    }
    // Before #515's fix the failing membership query left its client checked out.
    assert.equal(pool.totalCount - pool.idleCount, 0, "no connection may stay checked out");
  });
});

/**
 * Its own pool and app, with no Keycloak involved at all (a fake preHandler sets
 * `request.userId` directly): `registerWorkspaceScope`'s commit hook is what is under test
 * here, and nothing else should touch this pool while the one test below patches it.
 */
describe("registerWorkspaceScope's commit timing (#294)", () => {
  let pool: DbPool;
  let app: FastifyInstance;
  let workspaceId: string;
  let userId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    workspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [
      workspaceId,
    ]);
    const user = await pool.query<{ id: string }>(
      "INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id",
      [randomUUID(), `${randomUUID()}@example.com`],
    );
    userId = user.rows[0]!.id;
    await pool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [userId, workspaceId]);

    app = Fastify();
    registerWorkspaceScope(app);
    app.post(
      "/workspaces/:workspaceId/write-marker",
      { preHandler: [async (request) => { request.userId = userId; }, createWorkspaceMembershipPreHandler(pool)] },
      async (request) => {
        const { marker } = request.body as { marker: string };
        await request.db!.query("INSERT INTO audit_log (workspace_id, user_id, action) VALUES ($1, $2, $3)", [
          request.workspace!.id,
          null,
          marker,
        ]);
        return { ok: true };
      },
    );
  });

  after(async () => {
    await app.close();
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await pool.end();
  });

  it("does not let the response be observed until COMMIT has actually resolved", async () => {
    // Real timing is not reliable enough to prove this on its own (COMMIT usually finishes
    // fast regardless of which hook runs it): instead, an artificial delay on the COMMIT query
    // itself, deterministic either way — if the response can be observed before that delay
    // elapses, the app is not genuinely waiting for it (onResponse, #294's bug); if not, it is
    // (onSend, the fix).
    const poolAny = pool as unknown as { connect: (...args: unknown[]) => Promise<{ query: (...args: unknown[]) => unknown }> };
    const originalConnect = poolAny.connect.bind(poolAny);
    let commitResolvedAt = 0;
    const COMMIT_DELAY_MS = 150;

    poolAny.connect = async (...args: unknown[]) => {
      // pg's own Pool.query() (used by after()'s cleanup queries on this same pool) acquires
      // its connection through this same method, but in its callback form — pass those
      // straight through unpatched, since only the promise form (no args, as
      // createWorkspaceMembershipPreHandler uses) is what this test cares about wrapping.
      if (typeof args[0] === "function") {
        return originalConnect(...args);
      }
      const client = await originalConnect(...args);
      const originalQuery = client.query.bind(client);
      // Forwards every argument, not just (text, params): once released, this same client is
      // recycled by the pool for later, unrelated queries — some issued in pg's own callback
      // style (text, values, callback), whose callback this must not silently drop.
      client.query = async (...queryArgs: unknown[]) => {
        if (queryArgs[0] === "COMMIT") {
          await new Promise((resolve) => setTimeout(resolve, COMMIT_DELAY_MS));
          commitResolvedAt = Date.now();
        }
        return originalQuery(...queryArgs);
      };
      return client;
    };

    try {
      const response = await app.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/write-marker`,
        payload: { marker: `marker-${randomUUID()}` },
      });
      const responseObservedAt = Date.now();

      assert.equal(response.statusCode, 200);
      assert.ok(commitResolvedAt > 0, "COMMIT must have run and resolved by the time the response is observed");
      assert.ok(
        responseObservedAt >= commitResolvedAt,
        "the response must not be observable before its own transaction's COMMIT has resolved",
      );
    } finally {
      poolAny.connect = originalConnect;
    }
  });
});

/**
 * #515: the request's transaction is committed only for a reply below 400. The route below
 * writes an `audit_log` row carrying a unique marker first, then ends the request the way its
 * `outcome` parameter names; each test then looks for that marker with the pool directly
 * (superuser, bypasses RLS).
 */
describe("registerWorkspaceScope keeps a request's writes only for a successful reply (#515)", () => {
  let pool: DbPool;
  let app: FastifyInstance;
  let workspaceId: string;
  let userId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    workspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [
      workspaceId,
    ]);
    const user = await pool.query<{ id: string }>(
      "INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id",
      [randomUUID(), `${randomUUID()}@example.com`],
    );
    userId = user.rows[0]!.id;
    await pool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [userId, workspaceId]);

    app = Fastify();
    registerWorkspaceScope(app);
    app.post(
      "/workspaces/:workspaceId/write-then/:outcome",
      { preHandler: [async (request) => { request.userId = userId; }, createWorkspaceMembershipPreHandler(pool)] },
      async (request, reply) => {
        const { outcome } = request.params as { outcome: string };
        const { marker } = request.body as { marker: string };
        await request.db!.query("INSERT INTO audit_log (workspace_id, user_id, action) VALUES ($1, $2, $3)", [
          request.workspace!.id,
          null,
          marker,
        ]);
        if (outcome === "created") {
          await reply.code(201).send({ ok: true });
          return;
        }
        if (outcome === "validation-error") {
          try {
            // A JavaScript check after the write, not a SQL error: the transaction is still
            // healthy, so a COMMIT here would keep the row.
            throw new ValidationError("invalid_amount", "rejected after the write");
          } catch (error) {
            if (await sendIfValidationError(reply, error)) {
              return;
            }
            throw error;
          }
        }
        if (outcome === "conflict") {
          await reply.code(409).send({ error: "conflict" });
          return;
        }
        if (outcome === "throw") {
          throw new Error("unexpected failure after the write");
        }
        await reply.code(404).send({ error: "unknown outcome" });
      },
    );
  });

  after(async () => {
    await app.close();
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await pool.end();
  });

  async function writeThen(outcome: string): Promise<{ statusCode: number; stored: boolean }> {
    const marker = `marker-${randomUUID()}`;
    const response = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/write-then/${outcome}`,
      payload: { marker },
    });
    const { rowCount } = await pool.query("SELECT 1 FROM audit_log WHERE workspace_id = $1 AND action = $2", [
      workspaceId,
      marker,
    ]);
    return { statusCode: response.statusCode, stored: rowCount === 1 };
  }

  it("commits the write for a 2xx reply", async () => {
    assert.deepEqual(await writeThen("created"), { statusCode: 201, stored: true });
  });

  it("rolls the write back when a ValidationError raised after it replies 400", async () => {
    assert.deepEqual(await writeThen("validation-error"), { statusCode: 400, stored: false });
  });

  it("rolls the write back for any other 4xx reply", async () => {
    assert.deepEqual(await writeThen("conflict"), { statusCode: 409, stored: false });
    assert.deepEqual(await writeThen("unknown"), { statusCode: 404, stored: false });
  });

  it("still rolls the write back when the handler throws", async () => {
    assert.deepEqual(await writeThen("throw"), { statusCode: 500, stored: false });
  });

  it("returns the connection to the pool, whichever way the request ended", async () => {
    for (const outcome of ["created", "validation-error", "conflict", "throw"]) {
      await writeThen(outcome);
    }
    assert.equal(pool.totalCount - pool.idleCount, 0, "no client may stay checked out once the requests have finished");
  });
});
