/**
 * Proves #9's actual point: with the app connected as envelope_app, Row-Level
 * Security protects a query even when the query itself forgets to filter by
 * workspace — not just when SET ROLE simulates it (src/db/schema.test.ts).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import { decodeJwt } from "jose";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
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

describe("Row-Level Security, enforced for a real envelope_app connection", () => {
  let superuserPool: DbPool;
  let appPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: FastifyInstance;
  let ownWorkspaceId: string;
  let otherWorkspaceId: string;
  let createdUserId: string | undefined;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    appPool = createPool(appConnectionString(databaseUrl));

    realm = await setUpKeycloakTestRealm();
    const verifier = createTokenVerifier({ keycloakIssuer: realm.issuer, keycloakAudience: realm.audience });

    app = Fastify();
    registerWorkspaceScope(app);
    app.get(
      "/workspaces/:workspaceId/all-workspaces-unscoped",
      {
        preHandler: [
          createAuthPreHandler(verifier),
          createUserMapperPreHandler(appPool),
          createWorkspaceMembershipPreHandler(appPool),
        ],
      },
      // Deliberately unscoped: no WHERE clause. RLS, not this query, must hide other workspaces.
      async (request) => {
        const { rows } = await request.db!.query<{ id: string; name: string }>("SELECT id, name FROM workspaces");
        return { workspaces: rows };
      },
    );

    ownWorkspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Mine', 'EUR', 'Europe/Rome'), ($2, 'Not mine', 'EUR', 'Europe/Rome')",
      [ownWorkspaceId, otherWorkspaceId],
    );
  });

  after(async () => {
    await app.close();
    await superuserPool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[ownWorkspaceId, otherWorkspaceId]]);
    if (createdUserId) {
      await superuserPool.query("DELETE FROM users WHERE id = $1", [createdUserId]);
    }
    await realm.teardown();
    await appPool.end();
    await superuserPool.end();
  });

  it("an unscoped query, run by the app's own restricted connection, only ever returns the caller's workspace", async () => {
    const token = await realm.getUserToken();

    const beforeMembership = await app.inject({
      method: "GET",
      url: `/workspaces/${ownWorkspaceId}/all-workspaces-unscoped`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(beforeMembership.statusCode, 403);

    const subject = decodeJwt(token).sub;
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      subject,
    ]);
    const userId = rows[0]?.id;
    assert.ok(userId, "expected the user mapper to have created a local user for this token's subject");
    createdUserId = userId;
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [
      userId,
      ownWorkspaceId,
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/workspaces/${ownWorkspaceId}/all-workspaces-unscoped`,
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().workspaces, [{ id: ownWorkspaceId, name: "Mine" }]);
  });
});
