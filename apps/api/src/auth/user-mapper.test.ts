import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { createUserMapperPreHandler } from "./user-mapper.ts";
import { createAuthPreHandler, createTokenVerifier } from "./token-verifier.ts";

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

describe("user mapper, chained after the token verifier", () => {
  let pool: DbPool;
  let realm: KeycloakTestRealm;
  let app: FastifyInstance;
  let userId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    realm = await setUpKeycloakTestRealm();

    const verifier = createTokenVerifier({ keycloakIssuer: realm.issuer, keycloakAudience: realm.audience });
    app = Fastify();
    app.get(
      "/protected",
      { preHandler: [createAuthPreHandler(verifier), createUserMapperPreHandler(pool)] },
      async (request) => ({ userId: request.userId }),
    );
  });

  after(async () => {
    await app.close();
    if (userId) {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    }
    await realm.teardown();
    await pool.end();
  });

  it("creates one local user on first sign-in and reuses it on later requests", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${await realm.getUserToken()}` },
    });
    const second = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${await realm.getUserToken()}` },
    });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    userId = first.json().userId;
    assert.ok(userId);
    assert.equal(second.json().userId, userId);

    const { rows } = await pool.query("SELECT id FROM users WHERE id = $1", [userId]);
    assert.equal(rows.length, 1);
  });

  it("updates the stored email when the Keycloak profile's email changes", async () => {
    await realm.updateUserEmail("changed@example.com");

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${await realm.getUserToken()}` },
    });

    assert.equal(response.json().userId, userId);
    const { rows } = await pool.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
    assert.equal(rows[0]?.email, "changed@example.com");
  });
});
