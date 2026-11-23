import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";

import { decodeJwt } from "jose";

import {
  createTestRealm,
  deleteTestRealm,
  hostTag,
  isProcessAlive,
  judgeRealm,
  LEFTOVER_REALM_AGE_MS,
  parseTestRealmName,
  readRunRealm,
  RUN_REALM_ENV,
  setUpKeycloakTestRealm,
  sweepLeftoverTestRealms,
  testRealmExists,
  testRealmName,
} from "./keycloak.ts";

const adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD;
if (!adminPassword) {
  throw new Error("Set KEYCLOAK_ADMIN_PASSWORD (the value from infra/.env) before running the integration tests");
}

const NOW = Date.UTC(2026, 10, 22, 12);
const HOST = "0a1b2c3d";
const alive = new Set([1000]);
const context = { now: NOW, host: HOST, isProcessAlive: (pid: number) => alive.has(pid) };

/** A process id no process has any more: a child that has already exited. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(pid);
  return pid;
}

function realmOfIssuer(issuer: string): string {
  return issuer.slice(issuer.lastIndexOf("/") + 1);
}

describe("Keycloak test realm names (#639)", () => {
  it("reads back the host, process and start time a realm's name was given", () => {
    const name = testRealmName(4242, NOW, HOST);
    assert.match(name, /^envelope-test-run-0a1b2c3d-4242-[0-9a-z]+-[0-9a-f]{8}$/);
    assert.deepEqual(parseTestRealmName(name), { host: HOST, pid: 4242, startedAt: NOW });
    assert.notEqual(testRealmName(4242, NOW, HOST), name, "two realms of one process and millisecond still differ");
    assert.match(hostTag(), /^[0-9a-f]{8}$/);
  });

  it("deletes the realm of a process of this host that is gone, and keeps a live one's", () => {
    assert.equal(judgeRealm(testRealmName(1000, NOW - 60_000, HOST), context), "keep");
    assert.equal(judgeRealm(testRealmName(1001, NOW - 60_000, HOST), context), "delete");
  });

  it("keeps the realm of a live process of this host however old it is: a long walk keeps its realm", () => {
    assert.equal(judgeRealm(testRealmName(1000, NOW - LEFTOVER_REALM_AGE_MS - 1, HOST), context), "keep");
  });

  it("keeps another host's realm, whose process it cannot see, until it is older than the limit", () => {
    assert.equal(LEFTOVER_REALM_AGE_MS, 24 * 60 * 60 * 1000);
    assert.equal(judgeRealm(testRealmName(1001, NOW - LEFTOVER_REALM_AGE_MS, "ffffffff"), context), "keep");
    assert.equal(judgeRealm(testRealmName(1000, NOW - LEFTOVER_REALM_AGE_MS - 1, "ffffffff"), context), "delete");
  });

  it("tells this process from a later one that reused its id", { skip: process.platform !== "linux" }, () => {
    assert.equal(isProcessAlive(process.pid, Date.now()), true);
    assert.equal(isProcessAlive(process.pid, Date.now() - 365 * 24 * 60 * 60 * 1000), false, "a realm from before this process started");
    assert.equal(isProcessAlive(deadPid(), Date.now()), false);
  });

  it("gives another PID namespace with the same host name a tag of its own", () => {
    assert.notEqual(hostTag("envelope pid:[4026531836]"), hostTag("envelope pid:[4026532001]"));
  });

  it("reads the age of a per-file realm from before #639 from its users, and keeps every other realm", () => {
    assert.equal(judgeRealm("envelope-test-ee84be33-c17f-48a7-bb0b-b25e4dabbba1", context), "check-age");
    for (const realm of ["master", "envelope", "envelope-test", "envelope-explore-0a1b2c3d", "envelope-test-run-x"]) {
      assert.equal(judgeRealm(realm, context), "keep", realm);
    }
  });

  it("refuses a run realm handed down that is not a test realm", () => {
    assert.equal(readRunRealm({}), undefined);
    assert.deepEqual(readRunRealm({ [RUN_REALM_ENV]: JSON.stringify({ realm: testRealmName(), clientSecret: "s" }) })?.clientSecret, "s");
    assert.throws(() => readRunRealm({ [RUN_REALM_ENV]: JSON.stringify({ realm: "envelope", clientSecret: "s" }) }), {
      message: new RegExp(`${RUN_REALM_ENV} does not name a test realm`),
    });
  });
});

describe("Keycloak test realms, against a real Keycloak (#639)", () => {
  const created: string[] = [];
  const handedDown = process.env[RUN_REALM_ENV];

  after(async () => {
    if (handedDown === undefined) {
      delete process.env[RUN_REALM_ENV];
    } else {
      process.env[RUN_REALM_ENV] = handedDown;
    }
    for (const realm of created) {
      await deleteTestRealm(adminPassword, realm);
    }
  });

  it("gives every file of a run its own user in the one realm, and leaves the realm to the run", async () => {
    const run = await createTestRealm(adminPassword);
    created.push(run.realm);
    process.env[RUN_REALM_ENV] = JSON.stringify(run);

    const first = await setUpKeycloakTestRealm();
    const second = await setUpKeycloakTestRealm();
    assert.equal(realmOfIssuer(first.issuer), run.realm);
    assert.equal(second.issuer, first.issuer);
    assert.notEqual(decodeJwt(await first.getUserToken()).sub, decodeJwt(await second.getUserToken()).sub);

    await first.teardown();
    assert.ok(await second.getUserToken(), "the realm outlives the teardown of one file");
  });

  it("gives a file run on its own a realm of its own, and deletes it in the teardown", async () => {
    delete process.env[RUN_REALM_ENV];
    const own = await setUpKeycloakTestRealm();
    const realm = realmOfIssuer(own.issuer);
    created.push(realm);
    assert.equal(parseTestRealmName(realm)?.pid, process.pid);
    assert.ok(await own.getUserToken());

    await own.teardown();
    await assert.rejects(own.getUserToken(), /responded 404/);
  });

  it("sweeps the realms of a run that is gone, or from another host and too old, and keeps a live run's", async () => {
    const gone = await createTestRealm(adminPassword, testRealmName(deadPid()));
    const old = await createTestRealm(adminPassword, testRealmName(1, Date.now() - LEFTOVER_REALM_AGE_MS - 60_000, "ffffffff"));
    const live = await createTestRealm(adminPassword, testRealmName());
    created.push(gone.realm, old.realm, live.realm);

    // Another run's global setup sweeps the same Keycloak and may delete `gone` and `old` first
    // (#811), so the test checks what is left after the sweep, not which call deleted what.
    const deleted = await sweepLeftoverTestRealms(adminPassword);
    assert.equal(await testRealmExists(adminPassword, gone.realm), false, "the realm of a process that is gone");
    assert.equal(await testRealmExists(adminPassword, old.realm), false, "another host's realm older than the limit");
    assert.equal(await testRealmExists(adminPassword, live.realm), true, "the realm of this live process");
    assert.ok(!deleted.includes(live.realm), "the realm of this live process");
  });
});
