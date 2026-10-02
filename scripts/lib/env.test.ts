import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { assertSafeToRun, requireEnv } from "./env.ts";

describe("requireEnv", () => {
  it("returns the value when the variable is set", () => {
    process.env.ENVELOPE_SCRIPTS_TEST_VAR = "a value";
    assert.equal(requireEnv("ENVELOPE_SCRIPTS_TEST_VAR"), "a value");
    delete process.env.ENVELOPE_SCRIPTS_TEST_VAR;
  });

  it("throws when the variable is missing", () => {
    delete process.env.ENVELOPE_SCRIPTS_TEST_VAR;
    assert.throws(() => requireEnv("ENVELOPE_SCRIPTS_TEST_VAR"), /ENVELOPE_SCRIPTS_TEST_VAR/);
  });
});

describe("assertSafeToRun", () => {
  const LOCAL_URLS = {
    API_URL: "http://127.0.0.1:3000",
    DATABASE_URL: "postgres://envelope:pw@localhost:5432/envelope",
    KEYCLOAK_URL: "http://127.0.0.1:8080",
  };
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("does not throw when every URL is local and NODE_ENV is not production", () => {
    process.env.NODE_ENV = "development";
    assert.doesNotThrow(() => assertSafeToRun(LOCAL_URLS));
  });

  it("rejects a non-local API_URL, naming it", () => {
    process.env.NODE_ENV = "development";
    assert.throws(
      () => assertSafeToRun({ ...LOCAL_URLS, API_URL: "https://envelope.example.com" }),
      /API_URL/,
    );
  });

  it("rejects a non-local DATABASE_URL, naming it", () => {
    process.env.NODE_ENV = "development";
    assert.throws(
      () => assertSafeToRun({ ...LOCAL_URLS, DATABASE_URL: "postgres://user:pw@db.example.com:5432/envelope" }),
      /DATABASE_URL/,
    );
  });

  it("rejects a non-local KEYCLOAK_URL, naming it", () => {
    process.env.NODE_ENV = "development";
    assert.throws(
      () => assertSafeToRun({ ...LOCAL_URLS, KEYCLOAK_URL: "https://auth.example.com" }),
      /KEYCLOAK_URL/,
    );
  });

  it("rejects NODE_ENV=production even when every URL is local", () => {
    process.env.NODE_ENV = "production";
    assert.throws(() => assertSafeToRun(LOCAL_URLS), /production/);
  });
});
