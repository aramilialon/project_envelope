import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "./config.ts";

const BASE_ENV = { DATABASE_URL: "postgres://envelope@127.0.0.1:5432/envelope" };

describe("loadConfig", () => {
  it("applies defaults when only the required variable is set", () => {
    const config = loadConfig(BASE_ENV);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 3000);
    assert.equal(config.databaseUrl, BASE_ENV.DATABASE_URL);
    assert.equal(config.logLevel, "info");
    assert.equal(config.logPretty, false);
    assert.equal(config.nodeEnv, "development");
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

  it("rejects a missing DATABASE_URL", () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL/);
  });

  it("rejects a PORT that is not a positive integer", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: "not-a-number" }), /PORT/);
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: "-1" }), /PORT/);
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: "70000" }), /PORT/);
  });

  it("rejects an unknown LOG_LEVEL", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, LOG_LEVEL: "verbose" }), /LOG_LEVEL/);
  });

  it("rejects a LOG_PRETTY that is not a recognized boolean", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, LOG_PRETTY: "yes" }), /LOG_PRETTY/);
  });
});
