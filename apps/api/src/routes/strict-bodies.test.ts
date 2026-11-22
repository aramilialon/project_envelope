import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

/**
 * Strict bodies on portfolios, accounts and the workspace (#713), as #655 made them for a
 * transaction's edit: a key that is not one of the request's own fields, misspelt or one the
 * request cannot change, is a 400 `unknown_field` naming it, and nothing is written.
 */
describe("strict bodies on portfolios, accounts and the workspace (#713)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  const createdWorkspaceNames: string[] = [];

  const auth = () => ({ authorization: `Bearer ${token}` });

  async function send(method: "POST" | "PATCH" | "PUT", url: string, payload?: unknown) {
    return app.fastify.inject({
      method,
      url,
      headers: auth(),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  /** Sends `payload` and checks the 400 `unknown_field` naming `field`. */
  async function assertUnknownField(method: "POST" | "PATCH" | "PUT", url: string, payload: unknown, field: string) {
    const response = await send(method, url, payload);
    assert.equal(response.statusCode, 400, `${method} ${url} ${JSON.stringify(payload)}: ${response.body}`);
    assert.deepEqual(response.json(), { error: "unknown_field", details: { field } });
  }

  async function createAccount(payload: Record<string, unknown>): Promise<string> {
    const response = await send("POST", `/workspaces/${workspaceId}/accounts`, payload);
    assert.equal(response.statusCode, 201, response.body);
    return response.json().id;
  }

  async function createPortfolio(name: string): Promise<string> {
    const response = await send("POST", `/workspaces/${workspaceId}/portfolios`, { name });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().id;
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await superuserPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) AS matching`, params);
    return rows[0]!.n;
  }

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
  });

  // A fresh token before each test, so none depends on how long the realm's tokens live.
  beforeEach(async () => {
    token = await realm.getUserToken();
  });

  after(async () => {
    await superuserPool.query("DELETE FROM workspaces WHERE name = ANY($1)", [createdWorkspaceNames]);
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  describe("workspace", () => {
    it("POST refuses an unknown and an immutable key, creating nothing", async () => {
      const name = `Strict ${Date.now()}`;
      createdWorkspaceNames.push(name);
      const valid = { name, baseCurrency: "EUR", timeZone: "Europe/Rome" };
      await assertUnknownField("POST", "/workspaces", { ...valid, timezone: "Europe/Rome" }, "timezone");
      await assertUnknownField("POST", "/workspaces", { ...valid, taxCountry: "IT" }, "taxCountry");
      await assertUnknownField("POST", "/workspaces", { ...valid, id: workspaceId }, "id");
      assert.equal(await count("SELECT 1 FROM workspaces WHERE name = $1", [name]), 0);

      // The same body without the extra key is accepted.
      assert.equal((await send("POST", "/workspaces", valid)).statusCode, 201);
    });

    it("PATCH refuses a misspelt and an immutable key, changing nothing", async () => {
      const url = `/workspaces/${workspaceId}`;
      await assertUnknownField("PATCH", url, { taxcountry: "IT" }, "taxcountry");
      await assertUnknownField("PATCH", url, { taxCountry: "IT", timeZone: "Europe/Berlin" }, "timeZone");
      await assertUnknownField("PATCH", url, { taxCountry: "IT", baseCurrency: "USD" }, "baseCurrency");
      const { rows } = await superuserPool.query<{ tax_country: string | null; time_zone: string; base_currency: string }>(
        "SELECT tax_country, time_zone, base_currency FROM workspaces WHERE id = $1",
        [workspaceId],
      );
      assert.deepEqual(rows[0], { tax_country: null, time_zone: "Europe/Rome", base_currency: "EUR" });

      assert.equal((await send("PATCH", url, { taxCountry: null })).statusCode, 200);
    });

    it("PATCH refuses a body that is not a JSON object with invalid_body", async () => {
      const response = await send("PATCH", `/workspaces/${workspaceId}`, ["taxCountry"]);
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "invalid_body");
    });
  });

  describe("accounts", () => {
    const accountsUrl = () => `/workspaces/${workspaceId}/accounts`;

    it("POST refuses an unknown and an immutable key before any other check, creating nothing", async () => {
      const valid = { name: "Strict checking", type: "checking", currency: "EUR" };
      await assertUnknownField("POST", accountsUrl(), { ...valid, onbudget: true }, "onbudget");
      await assertUnknownField("POST", accountsUrl(), { ...valid, closedAt: "2026-01-01" }, "closedAt");
      // Two faults at once: the unknown key is the one named, not the missing type.
      await assertUnknownField("POST", accountsUrl(), { name: "Strict checking", typ: "checking", currency: "EUR" }, "typ");
      assert.equal(await count("SELECT 1 FROM accounts WHERE workspace_id = $1 AND name = $2", [workspaceId, valid.name]), 0);

      assert.equal((await send("POST", accountsUrl(), valid)).statusCode, 201);
    });

    it("PATCH refuses an unknown and an immutable key, changing nothing", async () => {
      const accountId = await createAccount({ name: "Strict broker", type: "brokerage", currency: "EUR" });
      const url = `${accountsUrl()}/${accountId}`;
      await assertUnknownField("PATCH", url, { domesticwithholdingagent: true }, "domesticwithholdingagent");
      await assertUnknownField("PATCH", url, { domesticWithholdingAgent: true, name: "Renamed" }, "name");
      await assertUnknownField("PATCH", url, { domesticWithholdingAgent: true, currency: "USD" }, "currency");
      const { rows } = await superuserPool.query<{ name: string; currency: string; domestic_withholding_agent: boolean | null }>(
        "SELECT name, currency, domestic_withholding_agent FROM accounts WHERE id = $1",
        [accountId],
      );
      assert.deepEqual(rows[0], { name: "Strict broker", currency: "EUR", domestic_withholding_agent: null });
    });

    it("close refuses any field, leaving the account open, and still closes with no body or {}", async () => {
      const accountId = await createAccount({ name: "Strict cash", type: "cash", currency: "EUR" });
      const url = `${accountsUrl()}/${accountId}/close`;
      await assertUnknownField("PATCH", url, { closedAt: "2026-01-01T00:00:00Z" }, "closedAt");
      assert.equal(await count("SELECT 1 FROM accounts WHERE id = $1 AND closed_at IS NULL", [accountId]), 1);

      assert.equal((await send("PATCH", url, {})).statusCode, 200);
      const other = await createAccount({ name: "Strict cash 2", type: "cash", currency: "EUR" });
      assert.equal((await send("PATCH", `${accountsUrl()}/${other}/close`)).statusCode, 200);
    });

    it("tax regimes: POST and PUT refuse an unknown key, in the body or in one entry, writing nothing", async () => {
      const accountId = await createAccount({ name: "Strict regimes", type: "brokerage", currency: "EUR" });
      const url = `${accountsUrl()}/${accountId}/tax-regimes`;
      await assertUnknownField("POST", url, { regime: "managed", validfrom: "2026-01-01" }, "validfrom");
      await assertUnknownField("PUT", url, { taxRegimes: [], accountId }, "accountId");
      await assertUnknownField(
        "PUT",
        url,
        { taxRegimes: [{ validFrom: "2026-01-01", regime: "managed" }, { validFrom: "2026-06-01", regim: "administered" }] },
        "taxRegimes[1].regim",
      );
      assert.equal(await count("SELECT 1 FROM account_tax_regimes WHERE account_id = $1", [accountId]), 0);
    });
  });

  describe("portfolios", () => {
    const portfoliosUrl = () => `/workspaces/${workspaceId}/portfolios`;

    it("POST refuses an unknown and an immutable key, creating nothing", async () => {
      await assertUnknownField("POST", portfoliosUrl(), { name: "Strict", purpos: "Long term" }, "purpos");
      await assertUnknownField("POST", portfoliosUrl(), { name: "Strict", archivedAt: null }, "archivedAt");
      // Two faults at once: the unknown key is the one named, not the missing name.
      await assertUnknownField("POST", portfoliosUrl(), { nome: "Strict" }, "nome");
      assert.equal(await count("SELECT 1 FROM portfolios WHERE workspace_id = $1 AND name = 'Strict'", [workspaceId]), 0);
    });

    it("PATCH refuses an unknown and an immutable key, changing nothing", async () => {
      const portfolioId = await createPortfolio("Strict patch");
      const url = `${portfoliosUrl()}/${portfolioId}`;
      await assertUnknownField("PATCH", url, { name: "Renamed", archive: true }, "archive");
      await assertUnknownField("PATCH", url, { name: "Renamed", workspaceId }, "workspaceId");
      assert.equal(
        await count("SELECT 1 FROM portfolios WHERE id = $1 AND name = 'Strict patch' AND archived_at IS NULL", [portfolioId]),
        1,
      );

      assert.equal((await send("PATCH", url, { name: "Renamed", purpose: null, archived: true })).statusCode, 200);
    });
  });
});
