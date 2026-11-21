import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig, loadDatabaseUrl } from "./config.ts";

const BASE_ENV = {
  APP_DATABASE_URL: "postgres://envelope_app@127.0.0.1:5432/envelope",
  KEYCLOAK_ISSUER: "http://127.0.0.1:8080/realms/envelope",
  KEYCLOAK_AUDIENCE: "envelope-api",
};

describe("loadConfig", () => {
  it("applies defaults when only the required variables are set", () => {
    const config = loadConfig(BASE_ENV);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 3000);
    assert.equal(config.databaseUrl, BASE_ENV.APP_DATABASE_URL);
    assert.equal(config.logLevel, "info");
    assert.equal(config.logPretty, false);
    assert.equal(config.nodeEnv, "development");
    assert.equal(config.keycloakIssuer, BASE_ENV.KEYCLOAK_ISSUER);
    assert.equal(config.keycloakAudience, BASE_ENV.KEYCLOAK_AUDIENCE);
    assert.deepEqual(config.trustProxy, []);
    assert.deepEqual(config.rateLimit, {
      addressMax: 2400,
      addressWindowMs: 60_000,
      userMax: 1200,
      userWindowMs: 60_000,
      userWriteMax: 120,
      userImportMax: 10,
    });
  });

  it("reads every variable when set", () => {
    const config = loadConfig({
      ...BASE_ENV,
      HOST: "0.0.0.0",
      PORT: "4000",
      LOG_LEVEL: "debug",
      LOG_PRETTY: "true",
      NODE_ENV: "production",
    });
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 4000);
    assert.equal(config.logLevel, "debug");
    assert.equal(config.logPretty, true);
    assert.equal(config.nodeEnv, "production");
  });

  it("reads the rate limits and the trusted proxies (#566)", () => {
    const config = loadConfig({
      ...BASE_ENV,
      TRUST_PROXY: "127.0.0.1, 10.0.0.0/24,::1",
      RATE_LIMIT_IP_MAX: "50",
      RATE_LIMIT_IP_WINDOW_SECONDS: "10",
      RATE_LIMIT_USER_MAX: "40",
      RATE_LIMIT_USER_WINDOW_SECONDS: "30",
      RATE_LIMIT_USER_WRITE_MAX: "20",
      RATE_LIMIT_USER_IMPORT_MAX: "2",
    });
    assert.deepEqual(config.trustProxy, ["127.0.0.1", "10.0.0.0/24", "::1"]);
    assert.deepEqual(config.rateLimit, {
      addressMax: 50,
      addressWindowMs: 10_000,
      userMax: 40,
      userWindowMs: 30_000,
      userWriteMax: 20,
      userImportMax: 2,
    });
  });

  it("rejects a rate limit that is not a positive integer", () => {
    for (const value of ["0", "-1", "1.5", "", "ten", "1e3"]) {
      assert.throws(() => loadConfig({ ...BASE_ENV, RATE_LIMIT_IP_MAX: value }), /RATE_LIMIT_IP_MAX/, value);
    }
    assert.throws(() => loadConfig({ ...BASE_ENV, RATE_LIMIT_USER_WINDOW_SECONDS: "0" }), /RATE_LIMIT_USER_WINDOW_SECONDS/);
  });

  it("refuses a TRUST_PROXY that would trust every address or is not an address", () => {
    for (const value of ["true", "*", "localhost", "127.0.0.1/33", "10.0.0.0/8/1", "127.0.0.1,"]) {
      assert.throws(() => loadConfig({ ...BASE_ENV, TRUST_PROXY: value }), /TRUST_PROXY/, value);
    }
  });

  it("rejects a missing APP_DATABASE_URL", () => {
    assert.throws(() => loadConfig({ KEYCLOAK_ISSUER: "x", KEYCLOAK_AUDIENCE: "x" }), /APP_DATABASE_URL/);
  });

  it("rejects a missing KEYCLOAK_ISSUER or KEYCLOAK_AUDIENCE", () => {
    assert.throws(() => loadConfig({ APP_DATABASE_URL: BASE_ENV.APP_DATABASE_URL }), /KEYCLOAK_ISSUER/);
    assert.throws(
      () => loadConfig({ APP_DATABASE_URL: BASE_ENV.APP_DATABASE_URL, KEYCLOAK_ISSUER: "x" }),
      /KEYCLOAK_AUDIENCE/,
    );
  });

  it("accepts PORT 0, which lets the operating system pick a free port", () => {
    assert.equal(loadConfig({ ...BASE_ENV, PORT: "0" }).port, 0);
  });

  it("rejects PORT 0 when NODE_ENV is production", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: "0", NODE_ENV: "production" }), /PORT cannot be 0/);
  });

  it("rejects a PORT that is not an integer between 0 and 65535", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: "not-a-number" }), /PORT/);
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: "-1" }), /PORT/);
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: "70000" }), /PORT/);
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: "" }), /PORT/);
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: " " }), /PORT/);
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: "0x10" }), /PORT/);
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: "1e3" }), /PORT/);
  });

  it("rejects an unknown LOG_LEVEL", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, LOG_LEVEL: "verbose" }), /LOG_LEVEL/);
  });

  it("rejects a LOG_PRETTY that is not a recognized boolean", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, LOG_PRETTY: "yes" }), /LOG_PRETTY/);
  });
});

describe("loadDatabaseUrl", () => {
  it("reads DATABASE_URL alone, without requiring the Keycloak variables", () => {
    const databaseUrl = "postgres://envelope@127.0.0.1:5432/envelope";
    assert.equal(loadDatabaseUrl({ DATABASE_URL: databaseUrl }), databaseUrl);
  });

  it("rejects a missing DATABASE_URL", () => {
    assert.throws(() => loadDatabaseUrl({}), /DATABASE_URL/);
  });
});
