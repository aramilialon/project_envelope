import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { isValidationError } from "@envelope/core";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import {
  createAssignmentBatch,
  findUndoneRows,
  listAssignmentTotals,
  reverseRows,
  undoAssignmentBatch,
  undoAssignmentEntry,
} from "./repository.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}

describe("assignment ledger repository", () => {
  let pool: DbPool;
  let workspaceId: string;
  let authorId: string;
  let categoryId: string;
  let otherCategoryId: string;

  before(async () => {
    pool = createPool(databaseUrl);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    workspaceId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Test', 'EUR', 'UTC')", [
      workspaceId,
    ]);
    const user = await pool.query<{ id: string }>(
      "INSERT INTO users (keycloak_subject, email) VALUES ($1, $2) RETURNING id",
      [randomUUID(), `${randomUUID()}@example.com`],
    );
    authorId = user.rows[0]!.id;
    const group = await pool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;
    const otherCategory = await pool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Fun', 2) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    otherCategoryId = otherCategory.rows[0]!.id;
  });

  after(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.query("DELETE FROM users WHERE id = $1", [authorId]);
    await pool.end();
  });

  it("assigns money from unassigned to a category", async () => {
    const [entry] = await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 5000 }],
    });
    assert.equal(entry?.sourceCategoryId, null);
    assert.equal(entry?.destinationCategoryId, categoryId);
    assert.equal(entry?.amountCents, 5000);
    assert.equal(entry?.author, authorId);
    assert.equal(entry?.reverses, null);
  });

  it("gives every entry of one call the same batch_id", async () => {
    const entries = await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [
        { month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 1000 },
        { month: "2026-09", sourceCategoryId: null, destinationCategoryId: otherCategoryId, amountCents: 2000 },
      ],
    });
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.batchId, entries[1]?.batchId);
  });

  it("moves money between two categories as one entry", async () => {
    const [entry] = await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month: "2026-09", sourceCategoryId: categoryId, destinationCategoryId: otherCategoryId, amountCents: 750 }],
    });
    assert.equal(entry?.sourceCategoryId, categoryId);
    assert.equal(entry?.destinationCategoryId, otherCategoryId);
  });

  it("rejects an entry with the same source and destination category", async () => {
    await assert.rejects(
      () =>
        createAssignmentBatch(pool, {
          workspaceId,
          author: authorId,
          entries: [{ month: "2026-09", sourceCategoryId: categoryId, destinationCategoryId: categoryId, amountCents: 100 }],
        }),
      (error: unknown) => isValidationError(error, "duplicate_category"),
    );
  });

  it("rejects an entry with no source and no destination", async () => {
    await assert.rejects(
      () =>
        createAssignmentBatch(pool, {
          workspaceId,
          author: authorId,
          entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: null, amountCents: 100 }],
        }),
      (error: unknown) => isValidationError(error, "duplicate_category"),
    );
  });

  it("rejects a non-positive amount", async () => {
    await assert.rejects(
      () =>
        createAssignmentBatch(pool, {
          workspaceId,
          author: authorId,
          entries: [{ month: "2026-09", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 0 }],
        }),
      (error: unknown) => isValidationError(error, "invalid_amount"),
    );
  });

  it("allows assigning more than is available (covers overspending)", async () => {
    const entries = await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [
        { month: "2026-10", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 1_000_000_00 },
      ],
    });
    assert.equal(entries.length, 1);
  });

  it("two concurrent moves to the same category and month both land", async () => {
    const month = "2026-11";
    const [a] = await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month, sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 300 }],
    });
    const [b] = await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month, sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 400 }],
    });
    assert.notEqual(a?.id, b?.id);

    const totals = await listAssignmentTotals(pool, workspaceId);
    const total = totals.find((t) => t.categoryId === categoryId && t.month === month);
    assert.equal(total?.amountCents, 700);
  });

  it("derives a category's net assigned amount as incoming minus outgoing", async () => {
    const month = "2026-12";
    await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month, sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 1000 }],
    });
    await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month, sourceCategoryId: categoryId, destinationCategoryId: otherCategoryId, amountCents: 400 }],
    });

    const totals = await listAssignmentTotals(pool, workspaceId);
    assert.equal(totals.find((t) => t.categoryId === categoryId && t.month === month)?.amountCents, 600);
    assert.equal(totals.find((t) => t.categoryId === otherCategoryId && t.month === month)?.amountCents, 400);
  });

  it("undoes a batch, reversing every row in it", async () => {
    const month = "2027-01";
    const original = await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [
        { month, sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 500 },
        { month, sourceCategoryId: null, destinationCategoryId: otherCategoryId, amountCents: 600 },
      ],
    });
    const batchId = original[0]!.batchId;

    const reversed = await undoAssignmentBatch(pool, workspaceId, batchId, authorId);
    assert.notEqual(reversed, "not_found");
    if (reversed === "not_found") return;
    assert.equal(reversed.length, 2);
    for (const row of reversed) {
      const source = original.find((o) => o.id === row.reverses);
      assert.ok(source, "each reversing row points back to an original row");
      assert.equal(row.sourceCategoryId, source?.destinationCategoryId);
      assert.equal(row.destinationCategoryId, source?.sourceCategoryId);
      assert.equal(row.amountCents, source?.amountCents);
    }

    const totals = await listAssignmentTotals(pool, workspaceId);
    assert.equal(totals.find((t) => t.categoryId === categoryId && t.month === month)?.amountCents ?? 0, 0);
    assert.equal(totals.find((t) => t.categoryId === otherCategoryId && t.month === month)?.amountCents ?? 0, 0);
  });

  it("undoing an already-undone batch a second time does nothing (no double reversal)", async () => {
    const month = "2027-02";
    const original = await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month, sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 200 }],
    });
    const batchId = original[0]!.batchId;

    const firstUndo = await undoAssignmentBatch(pool, workspaceId, batchId, authorId);
    assert.notEqual(firstUndo, "not_found");

    const secondUndo = await undoAssignmentBatch(pool, workspaceId, batchId, authorId);
    assert.notEqual(secondUndo, "not_found");
    if (secondUndo === "not_found") return;
    assert.equal(secondUndo.length, 0);
  });

  it("undoing an unknown batch reports not_found", async () => {
    const result = await undoAssignmentBatch(pool, workspaceId, randomUUID(), authorId);
    assert.equal(result, "not_found");
  });

  it("undoes a single row out of a larger batch, leaving the rest untouched", async () => {
    const month = "2027-03";
    const original = await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [
        { month, sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 100 },
        { month, sourceCategoryId: null, destinationCategoryId: otherCategoryId, amountCents: 150 },
      ],
    });
    const [first, second] = original;

    const undone = await undoAssignmentEntry(pool, workspaceId, first!.id, authorId);
    assert.notEqual(undone, "not_found");
    assert.notEqual(undone, "already_reversed");
    if (typeof undone === "string") return;
    assert.equal(undone.length, 1);
    assert.equal(undone[0]?.reverses, first!.id);

    const totals = await listAssignmentTotals(pool, workspaceId);
    assert.equal(totals.find((t) => t.categoryId === categoryId && t.month === month)?.amountCents ?? 0, 0);
    assert.equal(totals.find((t) => t.categoryId === otherCategoryId && t.month === month)?.amountCents, 150);

    // Undoing the whole original batch afterwards must not try to reverse `first` again.
    const batchUndo = await undoAssignmentBatch(pool, workspaceId, original[0]!.batchId, authorId);
    assert.notEqual(batchUndo, "not_found");
    if (batchUndo === "not_found") return;
    assert.equal(batchUndo.length, 1);
    assert.equal(batchUndo[0]?.reverses, second!.id);
  });

  it("undoing an already-undone single row reports already_reversed", async () => {
    const original = await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month: "2027-04", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 50 }],
    });
    const entryId = original[0]!.id;

    await undoAssignmentEntry(pool, workspaceId, entryId, authorId);
    const result = await undoAssignmentEntry(pool, workspaceId, entryId, authorId);
    assert.equal(result, "already_reversed");
  });

  it("undoing an unknown row reports not_found", async () => {
    const result = await undoAssignmentEntry(pool, workspaceId, randomUUID(), authorId);
    assert.equal(result, "not_found");
  });

  it("drops a row that lost the race to another device's reversal, instead of throwing (#43)", async () => {
    // Two offline devices each queue their own undo of the same row, from their own,
    // independently stale view that it is still undone: `findUndoneRows` here stands in for
    // that view, fetched once and reused for both "devices" so the second reverseRows call
    // sees the row as undoable even though the first call has, by then, already reversed it —
    // deterministically, with no real concurrency needed to trigger the exact race (design.md:
    // "already undone by the other device," not a real error).
    const original = await createAssignmentBatch(pool, {
      workspaceId,
      author: authorId,
      entries: [{ month: "2027-05", sourceCategoryId: null, destinationCategoryId: categoryId, amountCents: 75 }],
    });
    const staleView = await findUndoneRows(pool, workspaceId, "id = $2", [original[0]!.id]);

    const firstDevice = await reverseRows(pool, workspaceId, authorId, staleView);
    assert.equal(firstDevice.length, 1, "the first device to sync reverses the row normally");

    const secondDevice = await reverseRows(pool, workspaceId, authorId, staleView);
    assert.deepEqual(secondDevice, [], "the second device's own reversal must be dropped silently, not thrown");

    const { rows } = await pool.query("SELECT count(*) FROM assignment_ledger WHERE reverses = $1", [original[0]!.id]);
    assert.equal(Number(rows[0]!.count), 1, "only one reversal of the same row must ever exist");
  });
});
