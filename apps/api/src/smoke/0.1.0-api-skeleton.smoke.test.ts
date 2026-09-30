/**
 * Certifies 0.1.0 API skeleton's own "done when" (the API starts, migrates
 * an empty database, CI is green) against the real process: unlike every
 * other test here, this one starts the actual compiled server (main.ts) as
 * a subprocess and talks to it over a real HTTP connection, not
 * buildApp()+inject() (ADR 0007).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { ensureQueueRoleLogin, queueConnectionString } from "../test-helpers/queue-role.ts";
import { startServer, type RunningServer } from "./support.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("smoke: 0.1.0 API skeleton, against the real process", () => {
  let superuserPool: DbPool;
  let server: RunningServer;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    await ensureQueueRoleLogin(superuserPool);

    server = await startServer({
      HOST: "127.0.0.1",
      PORT: "3901",
      APP_DATABASE_URL: appConnectionString(databaseUrl),
      QUEUE_DATABASE_URL: queueConnectionString(databaseUrl),
      // /health does not touch Keycloak: any well-formed values satisfy loadConfig's validation.
      KEYCLOAK_ISSUER: "http://127.0.0.1:8080/realms/envelope",
      KEYCLOAK_AUDIENCE: "envelope-api",
      LOG_LEVEL: "fatal",
    });
  });

  after(async () => {
    await server.stop();
    await superuserPool.end();
  });

  it("starts, migrates an empty database, and answers a real GET /health over the network", async () => {
    const response = await fetch(`${server.baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", database: "connected" });
  });

  it("still guards an unknown route with the global auth hook, rather than leaking a bare 404", async () => {
    // The global auth preHandler (#10) runs before Fastify even resolves a route, so an
    // unauthenticated request to a path that does not exist gets the same 401 as one that
    // does — proving the hook truly applies to every path, not only registered ones.
    const response = await fetch(`${server.baseUrl}/not-a-real-route`);
    assert.equal(response.status, 401);
  });
});
