import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { buildApp, type App } from "../app.ts";
import { loadConfig } from "../config.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

// /health does not touch Keycloak: any well-formed values satisfy loadConfig's validation.
const KEYCLOAK_ENV = { KEYCLOAK_ISSUER: "http://127.0.0.1:8080/realms/envelope", KEYCLOAK_AUDIENCE: "envelope-api" };

describe("GET /health", () => {
  let app: App;

  before(() => {
    app = buildApp(loadConfig({ DATABASE_URL: databaseUrl, ...KEYCLOAK_ENV }));
  });

  after(() => app.close());

  it("reports the database as connected", async () => {
    const response = await app.fastify.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok", database: "connected" });
  });

  it("reports an error when the database is unreachable", async () => {
    const brokenApp = buildApp(
      loadConfig({ DATABASE_URL: "postgres://nope:nope@127.0.0.1:1/does-not-exist", ...KEYCLOAK_ENV }),
    );
    const response = await brokenApp.fastify.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 503);
    await brokenApp.close();
  });
});
