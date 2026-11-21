import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createPool, type DbPool } from "../db/pool.ts";
import { ensureAppRoleLogin } from "./app-role.ts";
import { requireIntegrationTestEnv } from "./integration-setup.ts";
import { ensureTestRoleLogin, roleConnectionString, testRoleLogin } from "./role-login.ts";

describe("test role logins (#585)", () => {
  const url = "postgres://envelope:secret@127.0.0.1:5432/envelope_test_a";

  it("gives every caller of one test database the same role and password", () => {
    assert.deepEqual(testRoleLogin("envelope_app", url), testRoleLogin("envelope_app", url));
    const { role, password } = testRoleLogin("envelope_app", url);
    assert.match(role, /^envelope_app_t[0-9a-f]{16}$/);
    assert.match(password, /^[0-9a-f]{64}$/);
    assert.match(testRoleLogin("envelope_queue", url).role, /^envelope_queue_t[0-9a-f]{16}$/);
  });

  it("gives another database, or another server, roles of its own", () => {
    const role = testRoleLogin("envelope_app", url).role;
    assert.notEqual(testRoleLogin("envelope_app", "postgres://envelope:secret@127.0.0.1:5432/envelope_test_b").role, role);
    assert.notEqual(testRoleLogin("envelope_app", "postgres://envelope:secret@127.0.0.1:55432/envelope_test_a").role, role);
  });

  it("derives the password from the superuser's own, so it cannot be guessed without it", () => {
    const other = testRoleLogin("envelope_app", "postgres://envelope:another@127.0.0.1:5432/envelope_test_a");
    assert.equal(other.role, testRoleLogin("envelope_app", url).role);
    assert.notEqual(other.password, testRoleLogin("envelope_app", url).password);
  });

  it("refuses a DATABASE_URL with no password, which would make the derived password a constant", () => {
    assert.throws(() => testRoleLogin("envelope_app", "postgres://envelope@127.0.0.1:5432/envelope_test_a"), {
      message: /DATABASE_URL must include the superuser's password/,
    });
  });

  it("builds a connection string that carries any password back unchanged", () => {
    const password = "p@ss:w%rd/'\"#?";
    const built = new URL(roleConnectionString("postgres://envelope:x@127.0.0.1:5432/envelope_test", "envelope_app", password));
    assert.equal(built.username, "envelope_app");
    assert.equal(decodeURIComponent(built.password), password);
    assert.equal(built.pathname, "/envelope_test");
  });
});

describe("test role logins on the server (#585)", () => {
  const { databaseUrl } = requireIntegrationTestEnv();
  let pool: DbPool;
  const created: string[] = [];

  before(() => {
    pool = createPool(databaseUrl);
  });

  after(async () => {
    for (const role of created) {
      await pool.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await pool.end();
  });

  async function sharedRoleLogins(): Promise<unknown[]> {
    const { rows } = await pool.query(
      "SELECT rolname, rolcanlogin, rolpassword FROM pg_authid WHERE rolname IN ('envelope_app', 'envelope_queue') ORDER BY rolname",
    );
    return rows;
  }

  it("never changes the login or password of envelope_app or envelope_queue themselves", async () => {
    const before = await sharedRoleLogins();
    // The migrations create both; without them the comparison below would prove nothing.
    assert.deepEqual(
      before.map((row) => (row as { rolname: string }).rolname),
      ["envelope_app", "envelope_queue"],
    );
    await ensureAppRoleLogin(pool);
    const other = testRoleLogin("envelope_queue", databaseUrl.replace(/\/[^/]*$/, `/not_a_database_${randomBytes(4).toString("hex")}`));
    created.push(other.role);
    await ensureTestRoleLogin(pool, "envelope_queue", other);
    assert.deepEqual(await sharedRoleLogins(), before);
  });

  it("creates a member of the shared role that can log in, and leaves it as it is the next time", async () => {
    const login = testRoleLogin("envelope_app", databaseUrl.replace(/\/[^/]*$/, `/not_a_database_${randomBytes(4).toString("hex")}`));
    created.push(login.role);
    await ensureTestRoleLogin(pool, "envelope_app", login);
    const asRole = createPool(roleConnectionString(databaseUrl, login.role, login.password));
    try {
      const { rows } = await asRole.query<{ member: boolean }>("SELECT pg_has_role(current_user, 'envelope_app', 'USAGE') AS member");
      assert.deepEqual(rows, [{ member: true }]);
    } finally {
      await asRole.end();
    }
    // Its comment names this test's own database, which exists for as long as the test runs, so
    // another run's sweep (which drops only roles whose database is gone) never drops it mid-test.
    const { rows: comments } = await pool.query<{ comment: string }>(
      "SELECT shobj_description(oid, 'pg_authid') AS comment FROM pg_roles WHERE rolname = $1",
      [login.role],
    );
    assert.deepEqual(comments, [{ comment: `envelope-test-role database=${decodeURIComponent(new URL(databaseUrl).pathname.slice(1))}` }]);
    const { rows: [first] } = await pool.query("SELECT oid, rolpassword FROM pg_authid WHERE rolname = $1", [login.role]);
    await ensureTestRoleLogin(pool, "envelope_app", login);
    const { rows: [second] } = await pool.query("SELECT oid, rolpassword FROM pg_authid WHERE rolname = $1", [login.role]);
    assert.deepEqual(second, first);
  });

  it("drops the test roles whose database is gone when it creates one", async () => {
    const stale = `envelope_app_t${randomBytes(8).toString("hex")}`;
    await pool.query(`CREATE ROLE ${stale} IN ROLE envelope_app`);
    created.push(stale);
    await pool.query(`COMMENT ON ROLE ${stale} IS 'envelope-test-role database=gone_${randomBytes(4).toString("hex")}'`);
    const login = testRoleLogin("envelope_app", databaseUrl.replace(/\/[^/]*$/, `/not_a_database_${randomBytes(4).toString("hex")}`));
    created.push(login.role);
    await ensureTestRoleLogin(pool, "envelope_app", login);
    const { rowCount } = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [stale]);
    assert.equal(rowCount, 0);
  });
});
