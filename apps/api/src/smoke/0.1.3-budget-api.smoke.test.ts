/**
 * Certifies 0.1.3 Budget API's own "done when" ("a full budget month can be
 * driven through the API alone") against the real process: unlike every
 * other test here, this one starts the actual compiled server (main.ts) as a
 * subprocess and talks to it over a real HTTP connection, not
 * buildApp()+inject() (ADR 0007). As a checkpoint milestone, it re-exercises
 * everything accumulated since 0.1.0: authentication (0.1.2), accounts,
 * categories, transactions, transfers, the assignment ledger, quick assign
 * and the owner/editor/read-only role restriction (0.1.3), all working
 * together in one real server.
 *
 * Randomized, not scripted (ADR 0007): a fixed-seed PRNG drives both a
 * positive scenario (valid operations; the invariant is computed
 * independently from the same random data, not copied from a prior run) and
 * a negative one (invalid operations; each checked against the correct
 * status/error code) — so this test cannot quietly pass by matching a
 * hardcoded expectation to the same mistake the implementation made.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { decodeJwt } from "jose";

import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { ensureQueueRoleLogin, queueConnectionString } from "../test-helpers/queue-role.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { TEST_VAPID_PRIVATE_KEY, TEST_VAPID_PUBLIC_KEY, TEST_VAPID_SUBJECT } from "../test-helpers/vapid-keys.ts";
import { startServer, type RunningServer } from "./support.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a test database before running the integration tests, " +
      "e.g. postgres://envelope:<password>@127.0.0.1:5432/envelope_test",
  );
}
if (!process.env.KEYCLOAK_ADMIN_PASSWORD) {
  throw new Error("Set KEYCLOAK_ADMIN_PASSWORD (the value from infra/.env) before running the integration tests");
}

/** Pseudo-random numbers with a fixed seed (mulberry32), so a failure is reproducible. */
function randomGenerator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MONTHS = ["2026-06", "2026-07", "2026-08"];

interface Recorded {
  readonly accountId: string;
  readonly amountCents: number;
  readonly month: string;
}

describe("smoke: 0.1.3 Budget API, against the real process", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let server: RunningServer;
  let token: string;
  let workspaceId: string;
  let checkingId: string;
  let walletId: string;
  let categoryIds: string[];

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    await ensureQueueRoleLogin(superuserPool);
    realm = await setUpKeycloakTestRealm();

    server = await startServer({
      HOST: "127.0.0.1",
      PORT: "3904",
      APP_DATABASE_URL: appConnectionString(databaseUrl),
      QUEUE_DATABASE_URL: queueConnectionString(databaseUrl),
      VAPID_SUBJECT: TEST_VAPID_SUBJECT,
      VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
      KEYCLOAK_ISSUER: realm.issuer,
      KEYCLOAK_AUDIENCE: realm.audience,
      LOG_LEVEL: "fatal",
    });

    workspaceId = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Smoke', 'EUR', 'UTC')",
      [workspaceId],
    );

    token = await realm.getUserToken();
    // A throwaway first request lets the user-mapper preHandler create the local users row,
    // before we can look it up to grant it membership (the same bootstrap every route test uses).
    await fetch(`${server.baseUrl}/workspaces/${workspaceId}/accounts`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const subject = decodeJwt(token).sub;
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      subject,
    ]);
    const userId = rows[0]?.id;
    assert.ok(userId, "expected the user mapper to have created a local user for this token's subject");
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [
      userId,
      workspaceId,
    ]);

    checkingId = await createAccount("Checking");
    walletId = await createAccount("Wallet");
    const groupId = await api<{ id: string }>("POST", "/category-groups", { name: "Everyday" }).then((r) => r.id);
    categoryIds = [];
    for (const name of ["Groceries", "Fun", "Transport", "Health"]) {
      categoryIds.push(await api<{ id: string }>("POST", "/categories", { name, groupId }).then((r) => r.id));
    }
  });

  after(async () => {
    await server.stop();
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await realm.teardown();
    await superuserPool.end();
  });

  function auth(): Record<string, string> {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${server.baseUrl}/workspaces/${workspaceId}${path}`, {
      method,
      headers: auth(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path} responded ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  async function createAccount(name: string): Promise<string> {
    const account = await api<{ id: string }>("POST", "/accounts", { name, type: "checking", currency: "EUR" });
    return account.id;
  }

  it("holds on real, randomly generated data: unassigned + every category's available + assigned in future + credit overspending equals the on-budget accounts' balance", async () => {
    const random = randomGenerator(19);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const amount = (max: number) => Math.floor(random() * max) + 1;
    const day = (month: string) => `${month}-${String(amount(27)).padStart(2, "0")}`;

    const recorded: Recorded[] = [];
    const record = (accountId: string, amountCents: number, month: string): void => {
      recorded.push({ accountId, amountCents, month });
    };

    const QUICK_ASSIGN_MODES = ["fund_targets", "cover_overspending", "cover_card_debt", "repeat_assigned", "repeat_spent"];

    for (let i = 0; i < 18; i++) {
      const month = pick(MONTHS);
      const account = pick([checkingId, walletId]);
      switch (Math.floor(random() * 5)) {
        case 0: {
          // income
          const cents = amount(200_000);
          await api("POST", `/accounts/${account}/transactions`, {
            occurredAt: day(month),
            splits: [{ categoryId: null, amountCents: cents }],
          });
          record(account, cents, month);
          break;
        }
        case 1: {
          // spending
          const cents = -amount(50_000);
          await api("POST", `/accounts/${account}/transactions`, {
            occurredAt: day(month),
            splits: [{ categoryId: pick(categoryIds), amountCents: cents }],
          });
          record(account, cents, month);
          break;
        }
        case 2: {
          // transfer between the two cash accounts
          const other = account === checkingId ? walletId : checkingId;
          const cents = amount(30_000);
          await api("POST", "/transfers", {
            sourceAccountId: account,
            destinationAccountId: other,
            occurredAt: day(month),
            amountCents: cents,
          });
          record(account, -cents, month);
          record(other, cents, month);
          break;
        }
        case 3: {
          // assign or move via the ledger: no effect on any account's own balance
          const source = Math.floor(random() * 2) === 0 ? null : pick(categoryIds);
          let destination: string | null = pick(categoryIds);
          if (source !== null && source === destination) {
            destination = categoryIds.find((c) => c !== source) ?? null;
          }
          await api("POST", "/assignments", {
            entries: [{ month, sourceCategoryId: source, destinationCategoryId: destination, amountCents: amount(60_000) }],
          });
          break;
        }
        default:
          // quick assign, any mode: also only ever moves money between unassigned and
          // categories via the ledger, never touching an account's own balance directly.
          await api("POST", "/quick-assign", { month, scope: { kind: "all" }, mode: pick(QUICK_ASSIGN_MODES) });
      }
    }

    for (const month of MONTHS) {
      const budgetMonth = await api<{
        unassigned: number;
        assignedInFuture: number;
        creditOverspending: number;
        categories: readonly { available: number }[];
        paymentCategories: readonly { available: number }[];
      }>("GET", `/budget-months/${month}`);

      const budgeted =
        budgetMonth.unassigned +
        [...budgetMonth.categories, ...budgetMonth.paymentCategories].reduce((sum, c) => sum + c.available, 0) +
        budgetMonth.assignedInFuture +
        budgetMonth.creditOverspending;
      const cashBalance = recorded
        .filter((r) => (r.accountId === checkingId || r.accountId === walletId) && r.month <= month)
        .reduce((sum, r) => sum + r.amountCents, 0);

      assert.equal(budgeted, cashBalance, `invariant violated for month ${month}`);
    }
  });

  it("rejects every randomly generated invalid operation with the correct status and error code", async () => {
    const random = randomGenerator(23);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const amount = (max: number) => Math.floor(random() * max) + 1;

    async function expectRejection(
      method: string,
      path: string,
      body: unknown,
      expectedStatus: number,
      expectedError?: string,
      headers: Record<string, string> = auth(),
    ): Promise<void> {
      const response = await fetch(`${server.baseUrl}/workspaces/${workspaceId}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, expectedStatus, `${method} ${path}`);
      if (expectedError !== undefined) {
        const responseBody = (await response.json()) as { error?: string };
        assert.equal(responseBody.error, expectedError, `${method} ${path}`);
      }
    }

    const cardA = await api<{ id: string }>("POST", "/accounts", {
      name: "Card A",
      type: "credit_card",
      currency: "EUR",
    }).then((a) => a.id);
    const cardB = await api<{ id: string }>("POST", "/accounts", {
      name: "Card B",
      type: "credit_card",
      currency: "EUR",
    }).then((a) => a.id);

    // split sum mismatch
    await expectRejection(
      "POST",
      `/accounts/${checkingId}/transactions`,
      { occurredAt: "2026-06-10", amountCents: -amount(1000), splits: [{ categoryId: categoryIds[0], amountCents: -1 }] },
      400,
      "split_mismatch",
    );

    // unknown category
    await expectRejection(
      "POST",
      `/accounts/${checkingId}/transactions`,
      { occurredAt: "2026-06-10", splits: [{ categoryId: randomUUID(), amountCents: -amount(1000) }] },
      400,
    );

    // credit-to-credit transfer
    await expectRejection(
      "POST",
      "/transfers",
      { sourceAccountId: cardA, destinationAccountId: cardB, occurredAt: "2026-06-10", amountCents: amount(1000) },
      400,
      "unsupported_transaction",
    );

    // transfer to the same account
    await expectRejection(
      "POST",
      "/transfers",
      { sourceAccountId: checkingId, destinationAccountId: checkingId, occurredAt: "2026-06-10", amountCents: amount(1000) },
      400,
      "duplicate_account",
    );

    // transfer naming an unknown account
    await expectRejection(
      "POST",
      "/transfers",
      { sourceAccountId: checkingId, destinationAccountId: randomUUID(), occurredAt: "2026-06-10", amountCents: amount(1000) },
      400,
      "unknown_account",
    );

    // non-positive transfer amount
    await expectRejection(
      "POST",
      "/transfers",
      { sourceAccountId: checkingId, destinationAccountId: walletId, occurredAt: "2026-06-10", amountCents: -amount(1000) },
      400,
      "invalid_amount",
    );

    // non-positive assignment amount
    await expectRejection(
      "POST",
      "/assignments",
      { entries: [{ month: "2026-06", sourceCategoryId: null, destinationCategoryId: categoryIds[0], amountCents: -amount(1000) }] },
      400,
      "invalid_amount",
    );

    // assignment entry with the same source and destination category
    await expectRejection(
      "POST",
      "/assignments",
      { entries: [{ month: "2026-06", sourceCategoryId: categoryIds[0], destinationCategoryId: categoryIds[0], amountCents: amount(1000) }] },
      400,
      "duplicate_category",
    );

    // malformed month
    await expectRejection("GET", "/budget-months/not-a-month", undefined, 400, "invalid_month");

    // no token at all: re-confirms 0.1.2's own guarantee, as part of this same run
    await expectRejection("GET", "/budget-months/2026-06", undefined, 401, undefined, {});

    // a read-only member (#24): rejected from a randomly picked write, but reads still work
    const readOnlyToken = await realm.getTokenForNewUser();
    await fetch(`${server.baseUrl}/workspaces/${workspaceId}/accounts`, {
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    const readOnlySubject = decodeJwt(readOnlyToken).sub;
    const { rows: readOnlyRows } = await superuserPool.query<{ id: string }>(
      "SELECT id FROM users WHERE keycloak_subject = $1",
      [readOnlySubject],
    );
    const readOnlyUserId = readOnlyRows[0]?.id;
    assert.ok(readOnlyUserId, "expected the user mapper to have created a local user for the read-only subject");
    await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'read_only')", [
      readOnlyUserId,
      workspaceId,
    ]);
    const readOnlyWrite = pick([
      { method: "POST", path: "/quick-assign", body: { month: "2026-06", scope: { kind: "all" }, mode: "cover_overspending" } },
      { method: "POST", path: "/assignments", body: { entries: [{ month: "2026-06", sourceCategoryId: null, destinationCategoryId: categoryIds[0], amountCents: amount(1000) }] } },
      { method: "POST", path: `/accounts/${checkingId}/transactions`, body: { occurredAt: "2026-06-10", splits: [{ categoryId: categoryIds[0], amountCents: -amount(1000) }] } },
    ]);
    await expectRejection("POST", readOnlyWrite.path, readOnlyWrite.body, 403, undefined, {
      authorization: `Bearer ${readOnlyToken}`,
      "content-type": "application/json",
    });
    const readOnlyRead = await fetch(`${server.baseUrl}/workspaces/${workspaceId}/budget-months/2026-06`, {
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    assert.equal(readOnlyRead.status, 200);
  });
});
