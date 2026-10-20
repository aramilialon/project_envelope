/**
 * The setup almost every route-level integration test repeated by hand: a real
 * PostgreSQL-backed app, migrated, with the app role logged in; a throwaway Keycloak realm; a
 * Fastify app built against both; one workspace; a real token for a user the global
 * auth/user-mapper preHandlers create on their first authenticated request (`GET /me`, which
 * needs no membership of its own); and that user granted a role in the workspace.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { decodeJwt } from "jose";

import { buildApp, type App } from "../app.ts";
import type { WorkspaceRole } from "../auth/workspace-membership.ts";
import { loadConfig } from "../config.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "./app-role.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "./keycloak.ts";

/**
 * @throws if `DATABASE_URL`/`KEYCLOAK_ADMIN_PASSWORD` are not set — call once at module scope
 * (not inside `before()`), the same way every integration test file already does, so a missing
 * one fails immediately rather than after `node --test` has already started collecting tests.
 */
export function requireIntegrationTestEnv(): { readonly databaseUrl: string } {
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
  return { databaseUrl };
}

export interface IntegrationTestContext {
  readonly superuserPool: DbPool;
  readonly realm: KeycloakTestRealm;
  readonly app: App;
  readonly workspaceId: string;
  readonly token: string;
}

export interface SetupIntegrationTestOptions {
  /** Extra environment entries `loadConfig` should see, e.g. VAPID keys for the notifications routes. */
  readonly configOverrides?: Record<string, string>;
  readonly role?: WorkspaceRole;
  readonly workspaceName?: string;
}

export async function setupIntegrationTest(options: SetupIntegrationTestOptions = {}): Promise<IntegrationTestContext> {
  const { databaseUrl } = requireIntegrationTestEnv();
  const superuserPool = createPool(databaseUrl);
  await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
  await ensureAppRoleLogin(superuserPool);
  const realm = await setUpKeycloakTestRealm();

  const app = buildApp(
    loadConfig({
      ...process.env,
      APP_DATABASE_URL: appConnectionString(databaseUrl),
      KEYCLOAK_ISSUER: realm.issuer,
      KEYCLOAK_AUDIENCE: realm.audience,
      ...options.configOverrides,
    }),
  );

  const workspaceId = randomUUID();
  await superuserPool.query(
    "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, $2, 'EUR', 'Europe/Rome')",
    [workspaceId, options.workspaceName ?? "Mine"],
  );

  const token = await realm.getUserToken();
  // Any authenticated route triggers the user-mapper preHandler; /me needs no membership of its
  // own, unlike a workspace-scoped route, so it never 403s/404s for an unrelated reason first.
  await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
  const subject = decodeJwt(token).sub;
  const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [subject]);
  const userId = rows[0]?.id;
  assert.ok(userId, "expected the user mapper to have created a local user for this token's subject");
  await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [
    userId,
    workspaceId,
    options.role ?? "owner",
  ]);

  return { superuserPool, realm, app, workspaceId, token };
}

export async function teardownIntegrationTest(ctx: IntegrationTestContext): Promise<void> {
  await ctx.app.close();
  await ctx.superuserPool.query("DELETE FROM workspaces WHERE id = $1", [ctx.workspaceId]);
  await ctx.realm.teardown();
  await ctx.superuserPool.end();
}
