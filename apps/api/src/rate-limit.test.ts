/**
 * The API's request limits (#566, ADR 0017), through `.inject()` against apps built with low
 * limits, each test with a fresh app and so fresh counters. `remoteAddress` stands in for the
 * client's connection; every other integration test runs with limits far above what it sends.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { LightMyRequestResponse } from "fastify";

import { buildApp, type App } from "./app.ts";
import { loadConfig } from "./config.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "./db/migrate.ts";
import { createPool, type DbPool } from "./db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "./test-helpers/app-role.ts";
import { requireIntegrationTestEnv } from "./test-helpers/integration-setup.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "./test-helpers/keycloak.ts";

const { databaseUrl } = requireIntegrationTestEnv();

const WEB_ORIGIN = "http://localhost:5173";

describe("rate limits", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let tokenA: string;
  let tokenB: string;
  const apps: App[] = [];

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    realm = await setUpKeycloakTestRealm();
    tokenA = await realm.getUserToken();
    tokenB = await realm.getTokenForNewUser();
  });

  after(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await realm.teardown();
    await superuserPool.end();
  });

  /** An app with the given limits; any limit not given is far above what a test sends. */
  function appWith(env: Record<string, string>): App {
    const app = buildApp(
      loadConfig({
        APP_DATABASE_URL: appConnectionString(databaseUrl),
        KEYCLOAK_ISSUER: realm.issuer,
        KEYCLOAK_AUDIENCE: realm.audience,
        WEB_ORIGIN,
        RATE_LIMIT_IP_MAX: "1000",
        RATE_LIMIT_USER_MAX: "1000",
        RATE_LIMIT_USER_WRITE_MAX: "1000",
        RATE_LIMIT_USER_IMPORT_MAX: "1000",
        ...env,
      }),
    );
    apps.push(app);
    return app;
  }

  function assertTooManyRequests(response: LightMyRequestResponse): void {
    assert.equal(response.statusCode, 429, response.body);
    const body = response.json<{ error: string; details: { retryAfterSeconds: number } }>();
    assert.equal(body.error, "too_many_requests");
    const retryAfter = Number(response.headers["retry-after"]);
    assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 60, `Retry-After: ${response.headers["retry-after"]}`);
    assert.equal(body.details.retryAfterSeconds, retryAfter);
  }

  describe("per client address", () => {
    it("limits the health check, answering 429 with Retry-After and the CORS headers the web app needs", async () => {
      const app = appWith({ RATE_LIMIT_IP_MAX: "3" });
      for (let i = 0; i < 3; i++) {
        const response = await app.fastify.inject({ method: "GET", url: "/health" });
        assert.equal(response.statusCode, 200);
      }
      const limited = await app.fastify.inject({ method: "GET", url: "/health", headers: { origin: WEB_ORIGIN } });
      assertTooManyRequests(limited);
      assert.equal(limited.headers["access-control-allow-origin"], WEB_ORIGIN);
      // Retry-After is not CORS-safelisted: the browser hands it to the web app only if exposed.
      const exposed = String(limited.headers["access-control-expose-headers"] ?? "").toLowerCase().split(/\s*,\s*/);
      assert.ok(exposed.includes("retry-after"), `Access-Control-Expose-Headers: ${limited.headers["access-control-expose-headers"]}`);
    });

    it("answers a CORS preflight before the limit, without counting it", async () => {
      const app = appWith({ RATE_LIMIT_IP_MAX: "2" });
      const preflight = {
        method: "OPTIONS" as const,
        url: "/workspaces",
        headers: { origin: WEB_ORIGIN, "access-control-request-method": "POST" },
      };
      for (let i = 0; i < 5; i++) {
        const response = await app.fastify.inject(preflight);
        assert.equal(response.statusCode, 204, response.body);
        assert.equal(response.headers["access-control-allow-origin"], WEB_ORIGIN);
      }
      // The preflights above used none of the address's allowance.
      for (let i = 0; i < 2; i++) {
        assert.equal((await app.fastify.inject({ method: "GET", url: "/health" })).statusCode, 200);
      }
      assertTooManyRequests(await app.fastify.inject({ method: "GET", url: "/health" }));
      // Once the address is over its limit, a preflight is still answered.
      assert.equal((await app.fastify.inject(preflight)).statusCode, 204);
    });

    it("counts requests with a bad token or none before authentication, separately for each address", async () => {
      const app = appWith({ RATE_LIMIT_IP_MAX: "3" });
      const badToken = { authorization: "Bearer not-a-token" };
      for (let i = 0; i < 2; i++) {
        assert.equal((await app.fastify.inject({ method: "GET", url: "/me", headers: badToken })).statusCode, 401);
      }
      assert.equal((await app.fastify.inject({ method: "GET", url: "/me" })).statusCode, 401);
      assertTooManyRequests(await app.fastify.inject({ method: "GET", url: "/me", headers: badToken }));
      // A valid token does not help an address over its limit: the limit comes first.
      assertTooManyRequests(await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${tokenA}` } }));

      const otherAddress = await app.fastify.inject({ method: "GET", url: "/me", headers: badToken, remoteAddress: "10.0.0.7" });
      assert.equal(otherAddress.statusCode, 401);
    });

    it("ignores X-Forwarded-For when no proxy is trusted", async () => {
      const app = appWith({ RATE_LIMIT_IP_MAX: "2" });
      for (const forwarded of ["203.0.113.1", "203.0.113.2"]) {
        const response = await app.fastify.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": forwarded } });
        assert.equal(response.statusCode, 200);
      }
      assertTooManyRequests(await app.fastify.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": "203.0.113.3" } }));
    });

    it("believes X-Forwarded-For only from a trusted proxy", async () => {
      const app = appWith({ RATE_LIMIT_IP_MAX: "2", TRUST_PROXY: "127.0.0.1" });
      // Through the proxy: each client its own count.
      for (const forwarded of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
        for (let i = 0; i < 2; i++) {
          const response = await app.fastify.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": forwarded } });
          assert.equal(response.statusCode, 200, `request ${i + 1} from ${forwarded}`);
        }
      }
      assertTooManyRequests(await app.fastify.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": "203.0.113.1" } }));

      // Straight from a client that is not the proxy: the header it chose is ignored.
      const direct = { remoteAddress: "198.51.100.9" };
      for (const forwarded of ["203.0.113.10", "203.0.113.11"]) {
        const response = await app.fastify.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": forwarded }, ...direct });
        assert.equal(response.statusCode, 200);
      }
      assertTooManyRequests(
        await app.fastify.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": "203.0.113.12" }, ...direct }),
      );
    });
  });

  describe("per user", () => {
    it("limits one user without touching another's count, from the same address", async () => {
      const app = appWith({ RATE_LIMIT_USER_MAX: "3" });
      const asA = { authorization: `Bearer ${tokenA}` };
      for (let i = 0; i < 3; i++) {
        assert.equal((await app.fastify.inject({ method: "GET", url: "/me", headers: asA })).statusCode, 200);
      }
      assertTooManyRequests(await app.fastify.inject({ method: "GET", url: "/me", headers: asA }));
      // The same user from another address is still the same user.
      assertTooManyRequests(await app.fastify.inject({ method: "GET", url: "/me", headers: asA, remoteAddress: "10.0.0.8" }));

      const asB = await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${tokenB}` } });
      assert.equal(asB.statusCode, 200);
    });

    it("answers 401, not 429, to a request without a valid token once the user limit is reached", async () => {
      const app = appWith({ RATE_LIMIT_USER_MAX: "1" });
      assert.equal((await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${tokenA}` } })).statusCode, 200);
      assertTooManyRequests(await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${tokenA}` } }));
      for (let i = 0; i < 3; i++) {
        assert.equal((await app.fastify.inject({ method: "GET", url: "/me" })).statusCode, 401);
        assert.equal(
          (await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer not-a-token" } })).statusCode,
          401,
        );
      }
    });

    it("limits writes more strictly than reads", async () => {
      const app = appWith({ RATE_LIMIT_USER_WRITE_MAX: "2" });
      const asA = { authorization: `Bearer ${tokenA}` };
      // An empty body: the route itself refuses it, but the attempt still counts as a write.
      for (let i = 0; i < 2; i++) {
        assert.equal((await app.fastify.inject({ method: "POST", url: "/workspaces", headers: asA, payload: {} })).statusCode, 400);
      }
      assertTooManyRequests(await app.fastify.inject({ method: "POST", url: "/workspaces", headers: asA, payload: {} }));
      assert.equal((await app.fastify.inject({ method: "GET", url: "/me", headers: asA })).statusCode, 200);

      const writeAsB = await app.fastify.inject({
        method: "POST",
        url: "/workspaces",
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {},
      });
      assert.equal(writeAsB.statusCode, 400);
    });

    it("limits file imports more strictly than other writes", async () => {
      const app = appWith({ RATE_LIMIT_USER_IMPORT_MAX: "1" });
      const asA = { authorization: `Bearer ${tokenA}` };
      // A workspace the user is not a member of: the route refuses it, after the limit has counted it.
      const importUrl = `/workspaces/${randomUUID()}/accounts/${randomUUID()}/import`;
      const first = await app.fastify.inject({ method: "POST", url: importUrl, headers: asA, payload: {} });
      assert.notEqual(first.statusCode, 429);
      assertTooManyRequests(await app.fastify.inject({ method: "POST", url: importUrl, headers: asA, payload: {} }));
      // Other writes still go through.
      assert.equal((await app.fastify.inject({ method: "POST", url: "/workspaces", headers: asA, payload: {} })).statusCode, 400);
    });
  });
});
