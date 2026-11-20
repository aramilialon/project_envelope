import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Hlc } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { findRecordedChange, getLatestChange, listChangesSince, recordChange } from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("change log repository (#42)", () => {
  let pool: DbPool;
  let workspaceId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    workspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [workspaceId]);
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.end();
  });

  function hlc(physical: number, counter = 0, deviceId = "device-a"): Hlc {
    return { physical, counter, deviceId };
  }

  it("records a change and reads it back as the latest for its entity/field", async () => {
    const entityId = randomUUID();
    await recordChange(pool, {
      id: randomUUID(),
      workspaceId,
      entityId,
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: "Groceries",
      outcome: "applied",
    });

    const latest = await getLatestChange(pool, workspaceId, entityId, "transactions.memo");
    assert.equal(latest?.value, "Groceries");
    assert.deepEqual(latest?.hlc, hlc(1000));
  });

  it("ignores a repeat of the same change id, never creating a duplicate row", async () => {
    const entityId = randomUUID();
    const change = {
      id: randomUUID(),
      workspaceId,
      entityId,
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: "Groceries",
      outcome: "applied" as const,
    };

    assert.equal(await recordChange(pool, change), true);
    assert.equal(await recordChange(pool, change), false, "a retried network request, same change id, inserts nothing");

    const { rows } = await pool.query("SELECT count(*) FROM change_log WHERE id = $1", [change.id]);
    assert.equal(Number(rows[0]!.count), 1, "sending the same change again must never create a duplicate row");
  });

  it("returns the change with the latest HLC for the same entity/field, regardless of insertion order", async () => {
    const entityId = randomUUID();
    await recordChange(pool, {
      id: randomUUID(),
      workspaceId,
      entityId,
      fieldName: "transactions.memo",
      hlc: hlc(2000),
      value: "later",
      outcome: "applied",
    });
    await recordChange(pool, {
      id: randomUUID(),
      workspaceId,
      entityId,
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: "earlier",
      outcome: "stale",
    });

    const latest = await getLatestChange(pool, workspaceId, entityId, "transactions.memo");
    assert.equal(latest?.value, "later");
  });

  it("keeps different fields of the same entity independent", async () => {
    const entityId = randomUUID();
    await recordChange(pool, {
      id: randomUUID(),
      workspaceId,
      entityId,
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: "a memo",
      outcome: "applied",
    });
    await recordChange(pool, {
      id: randomUUID(),
      workspaceId,
      entityId,
      fieldName: "transactions.payee",
      hlc: hlc(1000),
      value: "a payee",
      outcome: "applied",
    });

    assert.equal((await getLatestChange(pool, workspaceId, entityId, "transactions.memo"))?.value, "a memo");
    assert.equal((await getLatestChange(pool, workspaceId, entityId, "transactions.payee"))?.value, "a payee");
  });

  it("finds a recorded change by id with its outcome, and says whether a resend is the same change (#513)", async () => {
    const change = {
      id: randomUUID(),
      entityId: randomUUID(),
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: { nested: ["a"] },
    };
    await recordChange(pool, { ...change, workspaceId, outcome: "stale" });

    assert.deepEqual(await findRecordedChange(pool, workspaceId, change), { outcome: "stale", sameChange: true });
    assert.deepEqual(await findRecordedChange(pool, workspaceId, { ...change, value: { nested: ["b"] } }), {
      outcome: "stale",
      sameChange: false,
    });
    assert.deepEqual(await findRecordedChange(pool, workspaceId, { ...change, hlc: hlc(1000, 1) }), {
      outcome: "stale",
      sameChange: false,
    });
    assert.equal(await findRecordedChange(pool, workspaceId, { ...change, id: randomUUID() }), undefined);
  });

  it("returns undefined when a field has no recorded change yet", async () => {
    const latest = await getLatestChange(pool, workspaceId, randomUUID(), "transactions.memo");
    assert.equal(latest, undefined);
  });
});

describe("listChangesSince (#44)", () => {
  let pool: DbPool;
  const workspaceIds: string[] = [];

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = ANY($1)", [workspaceIds]);
    await pool.end();
  });

  function hlc(physical: number, counter = 0, deviceId = "device-a"): Hlc {
    return { physical, counter, deviceId };
  }

  /** Its own workspace per test: listChangesSince returns every change of a workspace, so tests sharing one would leak into each other. */
  async function newWorkspace(): Promise<string> {
    const id = randomUUID();
    workspaceIds.push(id);
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [id]);
    return id;
  }

  it("returns every change when since is omitted, ordered by clock", async () => {
    const workspaceId = await newWorkspace();
    const entityId = randomUUID();
    await recordChange(pool, { id: randomUUID(), workspaceId, entityId, fieldName: "transactions.memo", hlc: hlc(2000), value: "b", outcome: "applied" });
    await recordChange(pool, { id: randomUUID(), workspaceId, entityId, fieldName: "transactions.memo", hlc: hlc(1000), value: "a", outcome: "applied" });

    const changes = await listChangesSince(pool, workspaceId);
    assert.deepEqual(
      changes.map((c) => c.value),
      ["a", "b"],
    );
  });

  it("returns only changes later than the given clock", async () => {
    const workspaceId = await newWorkspace();
    const entityId = randomUUID();
    await recordChange(pool, { id: randomUUID(), workspaceId, entityId, fieldName: "transactions.memo", hlc: hlc(1000), value: "first", outcome: "applied" });
    await recordChange(pool, { id: randomUUID(), workspaceId, entityId, fieldName: "transactions.memo", hlc: hlc(2000), value: "second", outcome: "applied" });
    await recordChange(pool, { id: randomUUID(), workspaceId, entityId, fieldName: "transactions.memo", hlc: hlc(3000), value: "third", outcome: "applied" });

    const changes = await listChangesSince(pool, workspaceId, hlc(1000));
    assert.deepEqual(
      changes.map((c) => c.value),
      ["second", "third"],
    );
  });

  it("breaks a tie on physical/counter by device id, the same order compareHlc gives", async () => {
    const workspaceId = await newWorkspace();
    const entityId = randomUUID();
    await recordChange(pool, {
      id: randomUUID(),
      workspaceId,
      entityId,
      fieldName: "transactions.memo",
      hlc: hlc(5000, 0, "device-z"),
      value: "z",
      outcome: "applied",
    });
    await recordChange(pool, {
      id: randomUUID(),
      workspaceId,
      entityId,
      fieldName: "transactions.payee",
      hlc: hlc(5000, 0, "device-a"),
      value: "a",
      outcome: "applied",
    });

    const changes = await listChangesSince(pool, workspaceId, hlc(4000));
    assert.deepEqual(
      changes.map((c) => c.value),
      ["a", "z"],
    );
  });

  it("excludes another workspace's changes", async () => {
    const workspaceId = await newWorkspace();
    const otherWorkspaceId = await newWorkspace();
    await recordChange(pool, {
      id: randomUUID(),
      workspaceId: otherWorkspaceId,
      entityId: randomUUID(),
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: "not mine",
      outcome: "applied",
    });

    const changes = await listChangesSince(pool, workspaceId);
    assert.deepEqual(changes, []);
  });

  it("keeps the same change id in two workspaces as two changes, each listed only in its own (#513)", async () => {
    const workspaceId = await newWorkspace();
    const otherWorkspaceId = await newWorkspace();
    const sharedId = randomUUID();
    const change = { id: sharedId, entityId: randomUUID(), fieldName: "transactions.memo", hlc: hlc(1000) };

    assert.equal(await recordChange(pool, { ...change, workspaceId: otherWorkspaceId, value: "theirs", outcome: "applied" }), true);
    assert.equal(await recordChange(pool, { ...change, workspaceId, value: "mine", outcome: "applied" }), true);

    const mine = await listChangesSince(pool, workspaceId);
    assert.deepEqual(
      mine.map((c) => [c.id, c.value]),
      [[sharedId, "mine"]],
    );
    assert.deepEqual(await findRecordedChange(pool, workspaceId, { ...change, value: "mine" }), { outcome: "applied", sameChange: true });
    assert.equal(await findRecordedChange(pool, await newWorkspace(), { ...change, value: "theirs" }), undefined);
  });

  it("hides another workspace's change_log rows from envelope_app by Row-Level Security alone (#513)", async () => {
    const workspaceId = await newWorkspace();
    const otherWorkspaceId = await newWorkspace();
    const sharedId = randomUUID();
    const change = { id: sharedId, entityId: randomUUID(), fieldName: "transactions.memo", hlc: hlc(1000) };
    await recordChange(pool, { ...change, workspaceId, value: "mine", outcome: "applied" });
    await recordChange(pool, { ...change, workspaceId: otherWorkspaceId, value: "theirs", outcome: "applied" });
    await recordChange(pool, { ...change, id: randomUUID(), workspaceId: otherWorkspaceId, value: "theirs too", outcome: "applied" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE envelope_app");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      // No workspace_id filter at all: only the policy stands between this query and other workspaces.
      const { rows } = await client.query<{ workspace_id: string; value: unknown }>("SELECT workspace_id, value FROM change_log");
      assert.deepEqual(rows, [{ workspace_id: workspaceId, value: "mine" }]);
      const byId = await client.query("SELECT value FROM change_log WHERE id = $1", [sharedId]);
      assert.deepEqual(byId.rows, [{ value: "mine" }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
