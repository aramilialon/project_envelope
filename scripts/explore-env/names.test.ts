import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertEnvTargetsRun,
  assertExploreDatabase,
  assertExploreRealm,
  assertRunId,
  databaseName,
  newRunId,
  realmName,
  realmOfIssuer,
  runOf,
} from "./names.ts";

describe("run ids and names", () => {
  it("makes 8 lowercase hex digits", () => {
    for (let i = 0; i < 20; i++) {
      assert.match(newRunId(), /^[0-9a-f]{8}$/);
    }
  });

  it("builds the database and realm names from a run id", () => {
    assert.equal(databaseName("0a1b2c3d"), "envelope_explore_0a1b2c3d");
    assert.equal(realmName("0a1b2c3d"), "envelope-explore-0a1b2c3d");
  });

  it("refuses anything that is not a run id", () => {
    for (const bad of ["", "envelope", "0A1B2C3D", "0a1b2c3", "0a1b2c3d4", "0a1b2c3d;", "../0a1b2c"]) {
      assert.throws(() => assertRunId(bad), /Not a run id/);
      assert.throws(() => databaseName(bad), /Not a run id/);
      assert.throws(() => realmName(bad), /Not a run id/);
    }
  });

  it("reads the run back from a name, only for our own names", () => {
    assert.equal(runOf("envelope_explore_0a1b2c3d"), "0a1b2c3d");
    assert.equal(runOf("envelope-explore-0a1b2c3d"), "0a1b2c3d");
    assert.equal(runOf("envelope"), undefined);
    assert.equal(runOf("envelope_explore_"), undefined);
    assert.equal(runOf("envelope_explore_0a1b2c3d_x"), undefined);
    assert.equal(runOf("envelope_test_0a1b2c3d"), undefined);
  });
});

describe("assertExploreDatabase / assertExploreRealm", () => {
  it("accepts this tool's own names", () => {
    assertExploreDatabase("envelope_explore_0a1b2c3d");
    assertExploreRealm("envelope-explore-0a1b2c3d");
  });

  it("hard-refuses the shared database and realm and Keycloak's own database", () => {
    for (const name of ["envelope", "keycloak", "postgres", "template1", "master"]) {
      assert.throws(() => assertExploreDatabase(name), /Refusing to touch database/);
      assert.throws(() => assertExploreRealm(name), /Refusing to touch realm/);
    }
  });

  it("refuses names without the exact prefix", () => {
    for (const name of ["envelope_test", "envelope_explore", "envelope_explore_", "Envelope_explore_0a1b2c3d", "x_envelope_explore_0a1b2c3d", "envelope-explore-0a1b2c3d"]) {
      assert.throws(() => assertExploreDatabase(name), /Refusing/);
    }
    for (const name of ["envelope-test-1", "envelope-explore-", "envelope_explore_0a1b2c3d", "envelope-explore-0a1b2c3d/../envelope"]) {
      assert.throws(() => assertExploreRealm(name), /Refusing/);
    }
  });
});

describe("assertEnvTargetsRun", () => {
  const run = "0a1b2c3d";
  const ok = {
    KEYCLOAK_ISSUER: "http://127.0.0.1:8080/realms/envelope-explore-0a1b2c3d",
    APP_DATABASE_URL: "postgres://envelope_app:pw@127.0.0.1:5432/envelope_explore_0a1b2c3d",
    QUEUE_DATABASE_URL: "postgres://envelope_queue:pw@127.0.0.1:5432/envelope_explore_0a1b2c3d",
  };

  it("accepts an environment that names only this run's realm and database", () => {
    assertEnvTargetsRun(ok, run);
    assertEnvTargetsRun({ VITE_KEYCLOAK_ISSUER: ok.KEYCLOAK_ISSUER, VITE_API_URL: "http://127.0.0.1:1" }, run);
  });

  it("refuses the shared realm", () => {
    assert.throws(
      () => assertEnvTargetsRun({ ...ok, KEYCLOAK_ISSUER: "http://127.0.0.1:8080/realms/envelope" }, run),
      /KEYCLOAK_ISSUER names realm "envelope"/,
    );
    assert.throws(
      () => assertEnvTargetsRun({ VITE_KEYCLOAK_ISSUER: "http://127.0.0.1:8080/realms/envelope/" }, run),
      /VITE_KEYCLOAK_ISSUER/,
    );
  });

  it("refuses another run's realm or database", () => {
    assert.throws(() => assertEnvTargetsRun({ ...ok, KEYCLOAK_ISSUER: "http://127.0.0.1:8080/realms/envelope-explore-ffffffff" }, run), /KEYCLOAK_ISSUER/);
    assert.throws(() => assertEnvTargetsRun({ ...ok, APP_DATABASE_URL: "postgres://envelope_app:pw@127.0.0.1:5432/envelope" }, run), /APP_DATABASE_URL names database "envelope"/);
    assert.throws(() => assertEnvTargetsRun({ ...ok, QUEUE_DATABASE_URL: "postgres://q:pw@127.0.0.1:5432/envelope_explore_ffffffff" }, run), /QUEUE_DATABASE_URL/);
  });

  it("reads the realm out of an issuer", () => {
    assert.equal(realmOfIssuer("http://127.0.0.1:8080/realms/envelope"), "envelope");
    assert.throws(() => realmOfIssuer("http://127.0.0.1:8080/"), /Not a Keycloak issuer/);
  });
});
