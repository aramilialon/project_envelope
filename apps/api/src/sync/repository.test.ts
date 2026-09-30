import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { Hlc } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { getLatestChange, listChangesSince, recordChange } from "./repository.ts";

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
    };

    await recordChange(pool, change);
    await recordChange(pool, change); // a retried network request, same change id

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
    });
    await recordChange(pool, {
      id: randomUUID(),
      workspaceId,
      entityId,
      fieldName: "transactions.memo",
      hlc: hlc(1000),
      value: "earlier",
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
    });
    await recordChange(pool, {
      id: randomUUID(),
      workspaceId,
      entityId,
      fieldName: "transactions.payee",
      hlc: hlc(1000),
      value: "a payee",
    });

    assert.equal((await getLatestChange(pool, workspaceId, entityId, "transactions.memo"))?.value, "a memo");
    assert.equal((await getLatestChange(pool, workspaceId, entityId, "transactions.payee"))?.value, "a payee");
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
    await recordChange(pool, { id: randomUUID(), workspaceId, entityId, fieldName: "transactions.memo", hlc: hlc(2000), value: "b" });
    await recordChange(pool, { id: randomUUID(), workspaceId, entityId, fieldName: "transactions.memo", hlc: hlc(1000), value: "a" });

    const changes = await listChangesSince(pool, workspaceId);
    assert.deepEqual(
      changes.map((c) => c.value),
      ["a", "b"],
    );
  });

  it("returns only changes later than the given clock", async () => {
    const workspaceId = await newWorkspace();
    const entityId = randomUUID();
    await recordChange(pool, { id: randomUUID(), workspaceId, entityId, fieldName: "transactions.memo", hlc: hlc(1000), value: "first" });
    await recordChange(pool, { id: randomUUID(), workspaceId, entityId, fieldName: "transactions.memo", hlc: hlc(2000), value: "second" });
    await recordChange(pool, { id: randomUUID(), workspaceId, entityId, fieldName: "transactions.memo", hlc: hlc(3000), value: "third" });

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
    });
    await recordChange(pool, {
      id: randomUUID(),
      workspaceId,
      entityId,
      fieldName: "transactions.payee",
      hlc: hlc(5000, 0, "device-a"),
      value: "a",
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
    });

    const changes = await listChangesSince(pool, workspaceId);
    assert.deepEqual(changes, []);
  });
});
