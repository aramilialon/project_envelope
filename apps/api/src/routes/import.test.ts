import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { decodeJwt } from "jose";

import { buildApp, type App } from "../app.ts";
import { loadConfig } from "../config.ts";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../db/migrate.ts";
import { createPool, type DbPool } from "../db/pool.ts";
import { appConnectionString, ensureAppRoleLogin } from "../test-helpers/app-role.ts";
import { setUpKeycloakTestRealm, type KeycloakTestRealm } from "../test-helpers/keycloak.ts";

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

const MAPPING = {
  hasHeaderRow: true,
  dateColumn: 0,
  dateFormat: "YYYY-MM-DD",
  descriptionColumn: 1,
  amountColumn: 2,
  decimalSeparator: ".",
};

describe("import routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let accountId: string;
  let savingsAccountId: string;
  let offBudgetAccountId: string;
  let categoryId: string;
  let token: string;

  before(async () => {
    superuserPool = createPool(databaseUrl);
    await runMigrations(superuserPool, DEFAULT_MIGRATIONS_DIR);
    await ensureAppRoleLogin(superuserPool);
    realm = await setUpKeycloakTestRealm();

    app = buildApp(
      loadConfig({
        APP_DATABASE_URL: appConnectionString(databaseUrl),
        KEYCLOAK_ISSUER: realm.issuer,
        KEYCLOAK_AUDIENCE: realm.audience,
      }),
    );

    workspaceId = randomUUID();
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Mine', 'EUR', 'Europe/Rome')",
      [workspaceId],
    );
    const account = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Checking', 'checking', 'EUR') RETURNING id",
      [workspaceId],
    );
    accountId = account.rows[0]!.id;
    const savingsAccount = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency) VALUES ($1, 'Savings', 'savings', 'EUR') RETURNING id",
      [workspaceId],
    );
    savingsAccountId = savingsAccount.rows[0]!.id;
    const offBudgetAccount = await superuserPool.query<{ id: string }>(
      "INSERT INTO accounts (workspace_id, name, type, currency, on_budget) VALUES ($1, 'Brokerage', 'savings', 'EUR', false) RETURNING id",
      [workspaceId],
    );
    offBudgetAccountId = offBudgetAccount.rows[0]!.id;
    const group = await superuserPool.query<{ id: string }>(
      "INSERT INTO category_groups (workspace_id, name, sort_order) VALUES ($1, 'Home', 1) RETURNING id",
      [workspaceId],
    );
    const category = await superuserPool.query<{ id: string }>(
      "INSERT INTO categories (workspace_id, group_id, name, sort_order) VALUES ($1, $2, 'Groceries', 1) RETURNING id",
      [workspaceId, group.rows[0]!.id],
    );
    categoryId = category.rows[0]!.id;

    token = await realm.getUserToken();
    await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/staged-transactions`,
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
  });

  after(async () => {
    await app.close();
    await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await realm.teardown();
    await superuserPool.end();
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import-mapping`,
    });
    assert.equal(response.statusCode, 401);
  });

  it("saves and reads back a CSV mapping", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const missing = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${savingsAccountId}/import-mapping`,
      headers: auth,
    });
    assert.equal(missing.statusCode, 404);

    const saved = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import-mapping`,
      headers: auth,
      payload: MAPPING,
    });
    assert.equal(saved.statusCode, 200);

    const read = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import-mapping`,
      headers: auth,
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().amountColumn, 2);
  });

  it("rejects an invalid mapping", async () => {
    const response = await app.fastify.inject({
      method: "PUT",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import-mapping`,
      headers: { authorization: `Bearer ${token}` },
      payload: { hasHeaderRow: true },
    });
    assert.equal(response.statusCode, 400);
  });

  it("imports a CSV file using the account's saved mapping, then lists it as staged", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const imported = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import`,
      headers: auth,
      payload: { content: "Date,Description,Amount\n2026-09-15,Grocery store,-42.50\n" },
    });
    assert.equal(imported.statusCode, 201);
    const result = imported.json();
    assert.equal(result.staged.length, 1);
    assert.equal(result.duplicateCount, 0);

    const listed = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/staged-transactions`,
      headers: auth,
    });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json().staged.some((row: { id: string }) => row.id === result.staged[0].id));
  });

  it("imports an OFX file with no mapping at all, keeping the bank's own transaction id", async () => {
    const content =
      "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>" +
      "<STMTTRN><DTPOSTED>20261010000000<TRNAMT>-15.00<FITID>OFX-ROUTE-1<NAME>Coffee shop</STMTTRN>" +
      "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";

    const imported = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content, format: "ofx" },
    });
    assert.equal(imported.statusCode, 201);
    const result = imported.json();
    assert.equal(result.staged.length, 1);
    assert.equal(result.staged[0].externalId, "OFX-ROUTE-1");
  });

  it("imports a QIF file, inferring its date format and decimal separator with no mapping at all", async () => {
    const content = "!Type:Bank\nD21/10/2026\nPBakery\nT-12,34\n^\n";

    const imported = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content, format: "qif" },
    });
    assert.equal(imported.statusCode, 201);
    const result = imported.json();
    assert.equal(result.staged.length, 1);
    assert.equal(result.staged[0].amountCents, -1234);
  });

  it("rejects an ambiguous QIF file with a translatable error, and accepts an explicit hint instead", async () => {
    const content = "!Type:Bank\nD05/06/2026\nPUnclear\nT-10,00\n^\n";
    const auth = { authorization: `Bearer ${token}` };

    const ambiguous = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import`,
      headers: auth,
      payload: { content, format: "qif" },
    });
    assert.equal(ambiguous.statusCode, 400);
    assert.equal(ambiguous.json().error, "ambiguous_date_format");

    const withHint = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import`,
      headers: auth,
      payload: { content, format: "qif", dateFormat: "MM/DD/YYYY" },
    });
    assert.equal(withHint.statusCode, 201);
  });

  it("imports a CAMT.053 file with no mapping at all, keeping the account servicer's own reference", async () => {
    const content =
      "<Ntry><Amt>15.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-11-10</Dt></BookgDt>" +
      "<AcctSvcrRef>CAMT-ROUTE-1</AcctSvcrRef><NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Coffee shop</Nm></Cdtr>" +
      "</RltdPties></TxDtls></NtryDtls></Ntry>";

    const imported = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content, format: "camt053" },
    });
    assert.equal(imported.statusCode, 201);
    const result = imported.json();
    assert.equal(result.staged.length, 1);
    assert.equal(result.staged[0].externalId, "CAMT-ROUTE-1");
  });

  it("rejects an import with no mapping given and none saved", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${savingsAccountId}/import`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: "2026-09-15,Coffee,-3.50\n" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("confirms a staged row as a categorized transaction", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const imported = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import`,
      headers: auth,
      payload: { content: "Date,Description,Amount\n2026-09-16,Bookstore,-15.00\n" },
    });
    const stagedId = imported.json().staged[0].id;

    const confirmed = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/staged-transactions/confirm`,
      headers: auth,
      payload: { decisions: [{ stagedTransactionId: stagedId, kind: "category", categoryId }] },
    });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.json().outcomes[0].outcome, "confirmed");

    const listed = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/transactions`,
      headers: auth,
    });
    assert.ok(listed.json().transactions.some((t: { payee: string }) => t.payee === "Bookstore"));
  });

  it("rejects a confirmation naming an unknown category", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const imported = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import`,
      headers: auth,
      payload: { content: "Date,Description,Amount\n2026-09-17,Pharmacy,-8.00\n" },
    });
    const stagedId = imported.json().staged[0].id;

    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/staged-transactions/confirm`,
      headers: auth,
      payload: { decisions: [{ stagedTransactionId: stagedId, kind: "category", categoryId: randomUUID() }] },
    });
    assert.equal(response.statusCode, 400);
  });

  it("confirms a staged row as a transfer to an off-budget account given a category (#378, #379)", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const imported = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import`,
      headers: auth,
      payload: { content: "Date,Description,Amount\n2026-09-18,To brokerage,-50.00\n" },
    });
    const stagedId = imported.json().staged[0].id;

    const confirmed = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/staged-transactions/confirm`,
      headers: auth,
      payload: { decisions: [{ stagedTransactionId: stagedId, kind: "transfer", otherAccountId: offBudgetAccountId, categoryId }] },
    });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.json().outcomes[0].outcome, "confirmed");
  });

  it("rejects a transfer confirmation naming an unknown category", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const imported = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/import`,
      headers: auth,
      payload: { content: "Date,Description,Amount\n2026-09-19,To brokerage again,-60.00\n" },
    });
    const stagedId = imported.json().staged[0].id;

    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts/${accountId}/staged-transactions/confirm`,
      headers: auth,
      payload: {
        decisions: [{ stagedTransactionId: stagedId, kind: "transfer", otherAccountId: offBudgetAccountId, categoryId: randomUUID() }],
      },
    });
    assert.equal(response.statusCode, 400);
  });
});
