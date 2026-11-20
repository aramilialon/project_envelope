import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { roleConnectionString, rolePassword } from "./role-login.ts";

const VARIABLE = "ROLE_LOGIN_TEST_DATABASE_URL";

describe("test role passwords (#519)", () => {
  afterEach(() => {
    delete process.env[VARIABLE];
  });

  it("uses the password the environment's connection string gives that same role", () => {
    process.env[VARIABLE] = "postgres://envelope_app:dev%20secret@127.0.0.1:5432/envelope";
    assert.equal(rolePassword("envelope_app", VARIABLE, "fallback"), "dev secret");
  });

  it("ignores a connection string for another role, or one with no password", () => {
    process.env[VARIABLE] = "postgres://someone_else:secret@127.0.0.1:5432/envelope";
    assert.equal(rolePassword("envelope_app", VARIABLE, "fallback"), "fallback");
    process.env[VARIABLE] = "postgres://envelope_app@127.0.0.1:5432/envelope";
    assert.equal(rolePassword("envelope_app", VARIABLE, "fallback"), "fallback");
  });

  it("falls back when nothing gives one", () => {
    assert.equal(rolePassword("envelope_app", VARIABLE, "fallback"), "fallback");
  });

  it("builds a connection string that carries any password back unchanged", () => {
    const password = "p@ss:w%rd/'\"#?";
    const url = new URL(roleConnectionString("postgres://envelope:x@127.0.0.1:5432/envelope_test", "envelope_app", password));
    assert.equal(url.username, "envelope_app");
    assert.equal(decodeURIComponent(url.password), password);
    assert.equal(url.pathname, "/envelope_test");
  });
});
