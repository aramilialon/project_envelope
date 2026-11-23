/**
 * Cursor paging of an account's transactions (#560): `GET .../accounts/:accountId/transactions`
 * with `limit`, `order` and `cursor`, through the app role (`envelope_app`) the API runs as.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { decodeJwt } from "jose";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

interface Page {
  readonly transactions: readonly { readonly id: string; readonly occurredAt: string }[];
  readonly nextCursor: string | null;
}

const encode = (payload: unknown): string => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
const decode = (cursor: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;

describe("transaction paging", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let token: string;

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
    // A second workspace the same user is a member of, so a cursor of its own reaches the route
    // with a valid token and membership, and only the cursor's own scope can refuse it.
    otherWorkspaceId = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Theirs', 'EUR', 'Europe/Rome')",
      [otherWorkspaceId],
    );
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      decodeJwt(token).sub,
    ]);
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [
      rows[0]!.id,
      otherWorkspaceId,
    ]);
  });

  after(async () => {
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [otherWorkspaceId]);
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  async function newAccount(workspace = workspaceId): Promise<string> {
    const { rows } = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, $2, 'checking', 'EUR') RETURNING id",
      [workspace, `Checking ${randomUUID().slice(0, 8)}`],
    );
    return rows[0]!.id;
  }

  /** Inserts one transaction per instant, all in one statement (so one `created_at` unless given), and returns their ids in that order. */
  async function insert(
    accountId: string,
    occurredAt: readonly string[],
    createdAt?: readonly string[],
    workspace = workspaceId,
  ): Promise<string[]> {
    const { rows } = await superuserPool.query<{ id: string }>(
      `INSERT INTO transactions (workspace_id, account_id, occurred_at, status, created_at)
       SELECT $1, $2, o.at, 'pending', COALESCE(c.at, now())
       FROM unnest($3::timestamptz[]) WITH ORDINALITY AS o(at, n)
       LEFT JOIN unnest($4::timestamptz[]) WITH ORDINALITY AS c(at, n) USING (n)
       ORDER BY n
       RETURNING id`,
      [workspace, accountId, occurredAt, createdAt ?? []],
    );
    return rows.map((r) => r.id);
  }

  /** The account's ids in register order, as the database sorts them. */
  async function registerOrder(accountId: string, order: "asc" | "desc" = "asc"): Promise<string[]> {
    const direction = order === "asc" ? "ASC" : "DESC";
    const { rows } = await superuserPool.query<{ id: string }>(
      `SELECT id FROM transactions WHERE account_id = $1
       ORDER BY occurred_at ${direction}, created_at ${direction}, id ${direction}`,
      [accountId],
    );
    return rows.map((r) => r.id);
  }

  async function get(accountId: string, query: string, workspace = workspaceId) {
    return app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspace}/accounts/${accountId}/transactions${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function page(accountId: string, query: string, workspace = workspaceId): Promise<Page> {
    const response = await get(accountId, query, workspace);
    assert.equal(response.statusCode, 200, response.body);
    return response.json<Page>();
  }

  /** Every page, following nextCursor; returns the ids page by page. */
  async function allPages(accountId: string, params: string): Promise<string[][]> {
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? `?${params}` : `?${params}&cursor=${encodeURIComponent(cursor)}`;
      const body = await page(accountId, query);
      pages.push(body.transactions.map((t) => t.id));
      cursor = body.nextCursor;
      assert.ok(pages.length < 100, "the pages never end");
    } while (cursor !== null);
    return pages;
  }

  async function assertRefused(response: Awaited<ReturnType<typeof get>>, error: string, details: Record<string, unknown>): Promise<void> {
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json(), { error, details });
  }

  it("walks more than three pages in either order, every row once, in register order", async () => {
    const accountId = await newAccount();
    await insert(accountId, Array.from({ length: 10 }, (_, i) => `2026-03-${String(i + 1).padStart(2, "0")}T09:00:00Z`));

    for (const order of ["asc", "desc"] as const) {
      const pages = await allPages(accountId, `limit=3&order=${order}`);
      assert.deepEqual(pages.map((p) => p.length), [3, 3, 3, 1]);
      assert.deepEqual(pages.flat(), await registerOrder(accountId, order));
    }
  });

  it("orders oldest first when no order is given, and gives 100 rows when no limit is given", async () => {
    const accountId = await newAccount();
    await insert(accountId, Array.from({ length: 101 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString()));

    const first = await page(accountId, "");
    assert.equal(first.transactions.length, 100);
    assert.ok(first.nextCursor);
    const second = await page(accountId, `?cursor=${encodeURIComponent(first.nextCursor)}`);
    assert.equal(second.transactions.length, 1);
    assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.transactions, ...second.transactions].map((t) => t.id), await registerOrder(accountId, "asc"));
  });

  it("breaks a tie on the id: five rows with the same date written in one transaction", async () => {
    const accountId = await newAccount();
    const ids = await insert(accountId, Array.from({ length: 5 }, () => "2026-04-10T00:00:00Z"));

    for (const order of ["asc", "desc"] as const) {
      const pages = await allPages(accountId, `limit=2&order=${order}`);
      assert.deepEqual(pages.map((p) => p.length), [2, 2, 1]);
      const sorted = [...ids].sort();
      assert.deepEqual(pages.flat(), order === "asc" ? sorted : sorted.reverse());
    }
  });

  it("tells apart rows a microsecond apart, in occurred_at and in created_at", async () => {
    const accountId = await newAccount();
    // Within one millisecond: a cursor holding a JavaScript Date would round them together and skip rows.
    const byOccurredAt = await insert(accountId, [
      "2026-05-01T10:00:00.000003Z",
      "2026-05-01T10:00:00.000001Z",
      "2026-05-01T10:00:00.000002Z",
    ]);
    const byCreatedAt = await insert(
      accountId,
      ["2026-05-02T10:00:00Z", "2026-05-02T10:00:00Z", "2026-05-02T10:00:00Z"],
      ["2026-05-02T12:00:00.000502Z", "2026-05-02T12:00:00.000500Z", "2026-05-02T12:00:00.000501Z"],
    );
    const expected = [byOccurredAt[1], byOccurredAt[2], byOccurredAt[0], byCreatedAt[1], byCreatedAt[2], byCreatedAt[0]];

    const asc = await allPages(accountId, "limit=1&order=asc");
    assert.deepEqual(asc.flat(), expected);
    const desc = await allPages(accountId, "limit=1&order=desc");
    assert.deepEqual(desc.flat(), [...expected].reverse());
  });

  it("neither skips nor repeats a row when rows are added or deleted between two requests", async () => {
    const accountId = await newAccount();
    const original = await insert(accountId, ["01", "02", "03", "04", "05", "06"].map((d) => `2026-06-${d}T08:00:00Z`));

    const first = await page(accountId, "?limit=2");
    assert.deepEqual(first.transactions.map((t) => t.id), original.slice(0, 2));
    // Before the cursor's place (not shown later), at it (a tie on the date, written later: after it)
    // and further on; and the very row the cursor names is deleted.
    const [before] = await insert(accountId, ["2026-06-01T08:00:00Z"]);
    const [tied] = await insert(accountId, ["2026-06-02T08:00:00Z"]);
    const [later] = await insert(accountId, ["2026-06-05T08:00:00Z"]);
    await superuserPool.query("DELETE FROM transactions WHERE id = $1", [original[1]]);

    const rest: string[] = [];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const next = await page(accountId, `?limit=2&cursor=${encodeURIComponent(cursor)}`);
      rest.push(...next.transactions.map((t) => t.id));
      cursor = next.nextCursor;
    }
    assert.deepEqual(rest, [tied, original[2], original[3], original[4], later, original[5]]);
    assert.ok(!rest.includes(before!));
  });

  it("gives a null nextCursor on the last page, on a page that ends the list exactly, and on an empty account", async () => {
    const empty = await newAccount();
    assert.deepEqual(await page(empty, ""), { transactions: [], nextCursor: null });
    assert.deepEqual(await page(empty, "?order=desc&limit=1"), { transactions: [], nextCursor: null });

    const accountId = await newAccount();
    await insert(accountId, ["2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z", "2026-07-03T00:00:00Z"]);
    const exact = await page(accountId, "?limit=3");
    assert.equal(exact.transactions.length, 3);
    assert.equal(exact.nextCursor, null);
    const max = await page(accountId, "?limit=500");
    assert.equal(max.transactions.length, 3);
    assert.equal(max.nextCursor, null);
  });

  it("refuses a limit that is not a whole number from 1 to 500, or an unknown order, with invalid_field", async () => {
    const accountId = await newAccount();
    for (const limit of ["0", "501", "-1", "1.5", "1e2", "ten", "", "%201", "00000000001", "10000"]) {
      await assertRefused(await get(accountId, `?limit=${limit}`), "invalid_field", { field: "limit" });
    }
    await assertRefused(await get(accountId, "?limit=1&limit=2"), "invalid_field", { field: "limit" });
    for (const order of ["ASC", "descending", "", "random"]) {
      await assertRefused(await get(accountId, `?order=${order}`), "invalid_field", { field: "order" });
    }
    await assertRefused(await get(accountId, "?order=asc&order=desc"), "invalid_field", { field: "order" });
  });

  describe("a cursor that is not one of this list", () => {
    let accountId: string;
    let otherAccountId: string;
    let theirAccountId: string;
    let cursor: string;
    let theirCursor: string;

    before(async () => {
      accountId = await newAccount();
      otherAccountId = await newAccount();
      theirAccountId = await newAccount(otherWorkspaceId);
      const dates = ["2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z", "2026-08-03T00:00:00Z"];
      await insert(accountId, dates);
      await insert(otherAccountId, dates);
      await insert(theirAccountId, dates, undefined, otherWorkspaceId);
      cursor = (await page(accountId, "?limit=1")).nextCursor!;
      theirCursor = (await page(theirAccountId, "?limit=1", otherWorkspaceId)).nextCursor!;
      assert.ok(cursor && theirCursor);
    });

    const refuse = async (query: string, account = (): string => accountId): Promise<void> =>
      assertRefused(await get(account(), query), "invalid_cursor", {});

    it("refuses one that does not decode, with invalid_cursor and empty details", async () => {
      for (const bad of ["!!!", "bm90IGpzb24", encode([1, 2]), encode(null), encode("text"), "", "a".repeat(2_000)]) {
        await refuse(`?cursor=${encodeURIComponent(bad)}`);
      }
      await refuse(`?cursor=${encodeURIComponent(cursor)}&cursor=${encodeURIComponent(cursor)}`);
    });

    it("refuses one of another version, or whose fields are not what the API writes", async () => {
      const payload = decode(cursor);
      for (const change of [
        { v: 2 },
        { v: "1" },
        { o: "2026-08-01T00:00:00.000Z" },
        { o: "2026-02-30T00:00:00.000000Z" },
        { c: "2026-08-01 00:00:00+00" },
        { c: 1 },
        { i: "not-a-uuid" },
        { i: undefined },
        { d: undefined },
        // This very account, but named under another workspace the user is also a member of.
        { w: otherWorkspaceId },
        // Year 0000 passes a JavaScript Date but not PostgreSQL's timestamptz.
        { o: "0000-01-01T00:00:00.000000Z" },
        { c: "0000-01-01T00:00:00.000000Z" },
      ]) {
        await refuse(`?cursor=${encode({ ...payload, ...change })}`);
      }
    });

    it("refuses one given out for another account, or for the other order", async () => {
      await refuse(`?cursor=${encodeURIComponent(cursor)}`, () => otherAccountId);
      await refuse(`?order=desc&cursor=${encodeURIComponent(cursor)}`);
      const descCursor = (await page(accountId, "?limit=1&order=desc")).nextCursor!;
      await refuse(`?cursor=${encodeURIComponent(descCursor)}`);
      await refuse(`?order=asc&cursor=${encodeURIComponent(descCursor)}`);
    });

    it("refuses workspace B's cursor on workspace A's account, for a member of both, as the app role", async () => {
      await refuse(`?cursor=${encodeURIComponent(theirCursor)}`);
      // Rewritten to name this account and workspace, it is a well-formed cursor of this list: it
      // only gives a place in the order, and the rows after it are this account's own.
      const rewritten = encode({ ...decode(theirCursor), w: workspaceId, a: accountId });
      const body = await page(accountId, `?cursor=${rewritten}`);
      const theirIds = await registerOrder(theirAccountId);
      assert.ok(body.transactions.every((t) => !theirIds.includes(t.id)));
      assert.deepEqual(body.transactions.map((t) => t.id), (await registerOrder(accountId)).slice(1));
      // B's own cursor still works on B's own account.
      assert.deepEqual((await page(theirAccountId, `?cursor=${encodeURIComponent(theirCursor)}`, otherWorkspaceId)).transactions.length, 2);
    });

    it("answers 404 for another workspace's account before it reads the cursor", async () => {
      const response = await get(theirAccountId, `?cursor=${encodeURIComponent(theirCursor)}`);
      assert.equal(response.statusCode, 404);
    });
  });
});
