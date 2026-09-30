/**
 * Certifies 0.1.4 Import's own "done when" ("a real bank export imports
 * without duplicates on a second run") against the real process, for CSV
 * and OFX (#33): starts the actual compiled server (main.ts) as a
 * subprocess and talks to it over a real HTTP connection, not
 * buildApp()+inject() (ADR 0007).
 *
 * Randomized, not scripted (ADR 0007): a fixed-seed PRNG drives a random set
 * of transactions for each format, staged, confirmed, then staged again from
 * the exact same file content — the positive case, proving every row is
 * recognized as a duplicate of the transaction it already created and no
 * new one is added. A negative case then imports a second, genuinely
 * different random batch (dated well outside the first one's 3-day matching
 * window) and checks none of it is mistaken for a duplicate.
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

const PAYEES = ["Grocery store", "Bookstore", "Pharmacy", "Coffee shop", "Utility company", "Bakery"];

interface RandomTransaction {
  readonly day: number;
  readonly amountCents: number;
  readonly payee: string;
  readonly externalId: string;
}

function randomTransactions(seed: number, count: number, dayRange: readonly [number, number]): RandomTransaction[] {
  const random = randomGenerator(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const [minDay, maxDay] = dayRange;
  const transactions: RandomTransaction[] = [];
  for (let i = 0; i < count; i++) {
    const day = minDay + Math.floor(random() * (maxDay - minDay + 1));
    const amountCents = -(Math.floor(random() * 9000) + 100);
    transactions.push({ day, amountCents, payee: pick(PAYEES), externalId: `SMOKE-${seed}-${i}` });
  }
  return transactions;
}

function toCsv(month: string, transactions: readonly RandomTransaction[]): string {
  const rows = transactions.map((t) => {
    const date = `${month}-${String(t.day).padStart(2, "0")}`;
    const amount = (t.amountCents / 100).toFixed(2);
    return `${date},${t.payee},${amount}`;
  });
  return `Date,Description,Amount\n${rows.join("\n")}\n`;
}

function toOfx(month: string, transactions: readonly RandomTransaction[]): string {
  const entries = transactions.map((t) => {
    const date = `${month.replace(/-/g, "")}${String(t.day).padStart(2, "0")}000000`;
    const amount = (t.amountCents / 100).toFixed(2);
    return `<STMTTRN><DTPOSTED>${date}<TRNAMT>${amount}<FITID>${t.externalId}<NAME>${t.payee}</STMTTRN>`;
  });
  return `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>${entries.join("")}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

interface StagedRow {
  readonly id: string;
  readonly duplicateOf: string | null;
}

interface ImportResult {
  readonly staged: readonly StagedRow[];
  readonly duplicateCount: number;
}

describe("smoke: 0.1.4 Import, against the real process", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let server: RunningServer;
  let token: string;
  let workspaceId: string;
  let categoryId: string;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    await ensureQueueRoleLogin(superuserPool);
    realm = await setUpKeycloakTestRealm();

    server = await startServer({
      HOST: "127.0.0.1",
      PORT: "3905",
      APP_DATABASE_URL: appConnectionString(databaseUrl),
      QUEUE_DATABASE_URL: queueConnectionString(databaseUrl),
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

    const groupId = await api<{ id: string }>("POST", "/category-groups", { name: "Everyday" }).then((r) => r.id);
    categoryId = await api<{ id: string }>("POST", "/categories", { name: "Groceries", groupId }).then((r) => r.id);
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

  async function confirmAll(accountId: string, staged: readonly StagedRow[]): Promise<{ outcomes: readonly { outcome: string }[] }> {
    return api("POST", `/accounts/${accountId}/staged-transactions/confirm`, {
      decisions: staged.map((row) => ({ stagedTransactionId: row.id, kind: "category", categoryId })),
    });
  }

  it("re-importing the same CSV file a second time creates no duplicate transactions", async () => {
    const accountId = await createAccount("CSV checking");
    const transactions = randomTransactions(101, 8, [1, 27]);
    const content = toCsv("2026-06", transactions);
    const mapping = {
      hasHeaderRow: true,
      dateColumn: 0,
      dateFormat: "YYYY-MM-DD",
      descriptionColumn: 1,
      amountColumn: 2,
      decimalSeparator: ".",
    };

    const first = await api<ImportResult>("POST", `/accounts/${accountId}/import`, { content, mapping });
    assert.equal(first.duplicateCount, 0);
    assert.equal(first.staged.length, transactions.length);
    await confirmAll(accountId, first.staged);

    const afterFirst = await api<{ transactions: readonly unknown[] }>("GET", `/accounts/${accountId}/transactions`);
    assert.equal(afterFirst.transactions.length, transactions.length);

    // The exact same file, downloaded again.
    const second = await api<ImportResult>("POST", `/accounts/${accountId}/import`, { content, mapping });
    assert.equal(second.duplicateCount, transactions.length);
    assert.ok(second.staged.every((row) => row.duplicateOf !== null));
    const confirmation = await confirmAll(accountId, second.staged);
    assert.ok(confirmation.outcomes.every((o) => o.outcome === "duplicate_cleared"));

    const afterSecond = await api<{ transactions: readonly unknown[] }>("GET", `/accounts/${accountId}/transactions`);
    assert.equal(afterSecond.transactions.length, transactions.length, "no new transaction was created on the re-import");
  });

  it("re-importing the same OFX file a second time creates no duplicate transactions", async () => {
    const accountId = await createAccount("OFX checking");
    const transactions = randomTransactions(202, 8, [1, 27]);
    const content = toOfx("2026-07", transactions);

    const first = await api<ImportResult>("POST", `/accounts/${accountId}/import`, { content, format: "ofx" });
    assert.equal(first.duplicateCount, 0);
    await confirmAll(accountId, first.staged);

    const afterFirst = await api<{ transactions: readonly unknown[] }>("GET", `/accounts/${accountId}/transactions`);
    assert.equal(afterFirst.transactions.length, transactions.length);

    const second = await api<ImportResult>("POST", `/accounts/${accountId}/import`, { content, format: "ofx" });
    assert.equal(second.duplicateCount, transactions.length);
    const confirmation = await confirmAll(accountId, second.staged);
    assert.ok(confirmation.outcomes.every((o) => o.outcome === "duplicate_cleared"));

    const afterSecond = await api<{ transactions: readonly unknown[] }>("GET", `/accounts/${accountId}/transactions`);
    assert.equal(afterSecond.transactions.length, transactions.length, "no new transaction was created on the re-import");
  });

  it("a genuinely different import is not mistaken for a duplicate of an earlier one", async () => {
    const accountId = await createAccount("Negative case checking");
    const firstBatch = randomTransactions(303, 5, [1, 10]);
    const mapping = {
      hasHeaderRow: true,
      dateColumn: 0,
      dateFormat: "YYYY-MM-DD",
      descriptionColumn: 1,
      amountColumn: 2,
      decimalSeparator: ".",
    };
    const first = await api<ImportResult>("POST", `/accounts/${accountId}/import`, {
      content: toCsv("2026-08", firstBatch),
      mapping,
    });
    await confirmAll(accountId, first.staged);

    // A second batch, dated well outside the first one's 3-day matching window: a real new
    // statement, not a re-download of the same one.
    const secondBatch = randomTransactions(404, 5, [1, 10]);
    const second = await api<ImportResult>("POST", `/accounts/${accountId}/import`, {
      content: toCsv("2026-09", secondBatch),
      mapping,
    });
    assert.equal(second.duplicateCount, 0, "an unrelated statement must not be flagged as a duplicate");
    assert.ok(second.staged.every((row) => row.duplicateOf === null));
  });
});
