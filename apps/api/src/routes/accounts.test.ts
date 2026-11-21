import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { MAX_NAME_LENGTH, regimeAt, type TaxRegimeEntry } from "@envelope/core";
import { decodeJwt } from "jose";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

describe("accounts routes", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
  });

  after(async () => {
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts` });
    assert.equal(response.statusCode, 401);
  });

  it("creates, lists and closes an account", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: auth,
      payload: { name: "Checking", type: "checking", currency: "EUR" },
    });
    assert.equal(created.statusCode, 201);
    const account = created.json();
    assert.equal(account.name, "Checking");
    assert.equal(account.onBudget, true);
    assert.equal(account.paymentCategoryId, null);

    const listed = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts`, headers: auth });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json().accounts.some((a: { id: string }) => a.id === account.id));

    const closed = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${account.id}/close`,
      headers: auth,
    });
    assert.equal(closed.statusCode, 200);
    assert.ok(closed.json().closedAt);

    const closedAgain = await app.fastify.inject({
      method: "PATCH",
      url: `/workspaces/${workspaceId}/accounts/${account.id}/close`,
      headers: auth,
    });
    assert.equal(closedAgain.statusCode, 404);
  });

  it("creating an on-budget credit card links a payment category", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Visa", type: "credit_card", currency: "EUR" },
    });
    assert.equal(response.statusCode, 201);
    assert.ok(response.json().paymentCategoryId);
  });

  it("creates a brokerage account off budget when onBudget is not sent (#74)", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Broker", type: "brokerage", currency: "EUR" },
    });
    assert.equal(response.statusCode, 201);
    const account = response.json();
    assert.equal(account.type, "brokerage");
    assert.equal(account.onBudget, false);
    assert.equal(account.paymentCategoryId, null);
  });

  it("creates a brokerage account sent explicitly off budget", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Broker off", type: "brokerage", currency: "EUR", onBudget: false },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().onBudget, false);
  });

  it("rejects an on-budget brokerage account with a stable code", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Broker on", type: "brokerage", currency: "EUR", onBudget: true },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "brokerage_on_budget");

    const listed = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.ok(!listed.json().accounts.some((a: { name: string }) => a.name === "Broker on"));
  });

  it("refuses an on-budget account or card outside the workspace's base currency, storing nothing (#652)", async () => {
    for (const [name, type, onBudget] of [
      ["Dollar checking", "checking", undefined],
      ["Dollar savings", "savings", true],
      ["Dollar card", "credit_card", undefined],
    ] as const) {
      const response = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name, type, currency: "USD", ...(onBudget === undefined ? {} : { onBudget }) },
      });
      assert.equal(response.statusCode, 400, name);
      assert.deepEqual(response.json(), { error: "account_currency_not_base", details: { currency: "USD", baseCurrency: "EUR" } });
    }

    const listed = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.ok(!listed.json().accounts.some((a: { name: string }) => a.name.startsWith("Dollar")));
    const categories = await superuserPool.query("SELECT 1 FROM categories WHERE workspace_id = $1 AND name = 'Dollar card payment'", [workspaceId]);
    assert.equal(categories.rowCount, 0);
  });

  it("creates an off-budget account, card included, in another currency (#652)", async () => {
    for (const [name, type] of [
      ["US broker", "brokerage"],
      ["US savings", "savings"],
      ["US card", "credit_card"],
    ] as const) {
      const response = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name, type, currency: "USD", onBudget: false },
      });
      assert.equal(response.statusCode, 201, name);
      assert.equal(response.json().currency, "USD");
      assert.equal(response.json().onBudget, false);
    }
  });

  it("refuses a currency that is not a known upper-case ISO 4217 code, storing nothing (#652)", async () => {
    for (const [currency, onBudget] of [
      ["EURO", false],
      ["eur", false],
      ["XYZ", false],
      ["E1R", false],
      ["eur", true],
    ] as const) {
      const response = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: `Bad currency ${currency}`, type: "savings", currency, onBudget },
      });
      assert.equal(response.statusCode, 400, currency);
      assert.deepEqual(response.json(), { error: "invalid_currency", details: { currency } });
    }

    const listed = await app.fastify.inject({
      method: "GET",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.ok(!listed.json().accounts.some((a: { name: string }) => a.name.startsWith("Bad currency")));
  });

  it("creates an off-budget account in a zero- or three-decimal currency (#652)", async () => {
    for (const currency of ["JPY", "KWD"]) {
      const response = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: `Off ${currency}`, type: "savings", currency, onBudget: false },
      });
      assert.equal(response.statusCode, 201, currency);
      assert.equal(response.json().currency, currency);
    }
  });

  it("rejects an onBudget that is not a real boolean, storing nothing", async () => {
    for (const onBudget of ["false", 0, null]) {
      const name = `Not boolean ${String(onBudget)}`;
      const response = await app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name, type: "savings", currency: "EUR", onBudget },
      });
      assert.equal(response.statusCode, 400, `onBudget ${JSON.stringify(onBudget)}`);

      const listed = await app.fastify.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/accounts`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.ok(!listed.json().accounts.some((a: { name: string }) => a.name === name));
    }
  });

  it("rejects an invalid account body", async () => {
    const response = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "", type: "not-a-type", currency: "EUR" },
    });
    assert.equal(response.statusCode, 400);
  });

  it("caps the account name at the name limit, counted in characters (#507)", async () => {
    const auth = { authorization: `Bearer ${token}` };
    // Emoji are two UTF-16 code units each: the limit counts characters, so this is exactly at it.
    const atLimit = "💶".repeat(MAX_NAME_LENGTH);
    const accepted = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: auth,
      payload: { name: atLimit, type: "checking", currency: "EUR" },
    });
    assert.equal(accepted.statusCode, 201);
    assert.equal(accepted.json().name, atLimit);

    const rejected = await app.fastify.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/accounts`,
      headers: auth,
      payload: { name: "a".repeat(MAX_NAME_LENGTH + 1), type: "checking", currency: "EUR" },
    });
    assert.equal(rejected.statusCode, 400);
    assert.deepEqual(rejected.json(), { error: "text_too_long", details: { field: "name", max: MAX_NAME_LENGTH } });
  });

  describe("tax regime of brokerage accounts (#508)", () => {
    const auth = () => ({ authorization: `Bearer ${token}` });
    /** A brokerage account created before the workspace's tax country was set: no regime, no flag. */
    let legacyBrokerageId: string;
    /** Another workspace, with a brokerage account and a regime of its own. */
    let otherWorkspaceId: string;
    let otherAccountId: string;

    async function create(payload: Record<string, unknown>) {
      return app.fastify.inject({ method: "POST", url: `/workspaces/${workspaceId}/accounts`, headers: auth(), payload });
    }

    async function accountNames(): Promise<string[]> {
      const listed = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts`, headers: auth() });
      return listed.json().accounts.map((a: { name: string }) => a.name);
    }

    function regimesUrl(accountId: string): string {
      return `/workspaces/${workspaceId}/accounts/${accountId}/tax-regimes`;
    }

    async function history(accountId: string, headers = auth()) {
      return app.fastify.inject({ method: "GET", url: regimesUrl(accountId), headers });
    }

    async function addRegime(accountId: string, payload: Record<string, unknown>, headers = auth()) {
      return app.fastify.inject({ method: "POST", url: regimesUrl(accountId), headers, payload });
    }

    async function replaceHistory(accountId: string, taxRegimes: unknown, headers = auth()) {
      return app.fastify.inject({ method: "PUT", url: regimesUrl(accountId), headers, payload: { taxRegimes } });
    }

    async function setFlag(accountId: string, domesticWithholdingAgent: unknown, headers = auth()) {
      return app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}/accounts/${accountId}`,
        headers,
        payload: { domesticWithholdingAgent },
      });
    }

    async function setTaxCountry(taxCountry: string | null) {
      const response = await app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}`,
        headers: auth(),
        payload: { taxCountry },
      });
      assert.equal(response.statusCode, 200);
    }

    /** A token for a new user who is a member of the workspace with `role`; refreshes the owner's token after. */
    async function memberToken(role: "editor" | "read_only"): Promise<string> {
      const memberToken = await realm.getTokenForNewUser();
      await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${memberToken}` } });
      const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
        decodeJwt(memberToken).sub,
      ]);
      await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [
        rows[0]!.id,
        workspaceId,
        role,
      ]);
      // Creating that user can take long enough for the owner's token to expire.
      token = await realm.getUserToken();
      return memberToken;
    }

    // A fresh token before each test rather than the one the file's setup obtained, so no test
    // depends on how long the realm's access tokens live (test-helpers/keycloak.ts: a minute).
    beforeEach(async () => {
      token = await realm.getUserToken();
    });

    before(async () => {
      token = await realm.getUserToken();
      const legacy = await create({ name: "Broker before IT", type: "brokerage", currency: "EUR" });
      assert.equal(legacy.statusCode, 201);
      legacyBrokerageId = legacy.json().id;
      await setTaxCountry("IT");

      const other = await superuserPool.query<{ id: string }>(
        "INSERT INTO workspaces (name, base_currency, time_zone, tax_country) VALUES ('Not mine', 'EUR', 'Europe/Rome', 'IT') RETURNING id",
      );
      otherWorkspaceId = other.rows[0]!.id;
      const account = await superuserPool.query<{ id: string }>(
        `INSERT INTO accounts (workspace_id, name, type, currency, on_budget, domestic_withholding_agent)
         VALUES ($1, 'Their broker', 'brokerage', 'EUR', false, true) RETURNING id`,
        [otherWorkspaceId],
      );
      otherAccountId = account.rows[0]!.id;
      await superuserPool.query(
        "INSERT INTO account_tax_regimes (workspace_id, account_id, valid_from, regime) VALUES ($1, $2, '2020-05-05', 'administered')",
        [otherWorkspaceId, otherAccountId],
      );
    });

    after(async () => {
      await superuserPool.query("UPDATE workspaces SET tax_country = NULL WHERE id = $1", [workspaceId]);
      await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [otherWorkspaceId]);
    });

    it("requires a regime and the withholding-agent flag on a brokerage account in an IT workspace, storing nothing", async () => {
      const noRegime = await create({ name: "IT no regime", type: "brokerage", currency: "EUR", domesticWithholdingAgent: true });
      assert.equal(noRegime.statusCode, 400);
      assert.deepEqual(noRegime.json(), { error: "tax_regime_required", details: { field: "taxRegime", taxCountry: "IT" } });

      const noFlag = await create({ name: "IT no flag", type: "brokerage", currency: "EUR", taxRegime: "self_declared" });
      assert.equal(noFlag.statusCode, 400);
      assert.equal(noFlag.json().error, "tax_regime_required");
      assert.equal(noFlag.json().details.field, "domesticWithholdingAgent");

      const names = await accountNames();
      assert.ok(!names.includes("IT no regime") && !names.includes("IT no flag"));
    });

    it("refuses an administered or managed regime unless the broker is an Italian withholding agent", async () => {
      for (const taxRegime of ["administered", "managed"]) {
        const refused = await create({
          name: `Foreign ${taxRegime}`,
          type: "brokerage",
          currency: "EUR",
          taxRegime,
          domesticWithholdingAgent: false,
        });
        assert.equal(refused.statusCode, 400, taxRegime);
        assert.deepEqual(refused.json(), { error: "tax_regime_requires_withholding_agent", details: { regime: taxRegime } });
      }
      const names = await accountNames();
      assert.ok(!names.includes("Foreign administered") && !names.includes("Foreign managed"));

      const foreign = await create({
        name: "Foreign self-declared",
        type: "brokerage",
        currency: "EUR",
        taxRegime: "self_declared",
        domesticWithholdingAgent: false,
      });
      assert.equal(foreign.statusCode, 201);
      const change = await addRegime(foreign.json().id, { validFrom: "2027-01-01", regime: "managed" });
      assert.equal(change.statusCode, 400);
      assert.equal(change.json().error, "tax_regime_requires_withholding_agent");
      assert.equal((await history(foreign.json().id)).json().taxRegimes.length, 1);
    });

    it("refuses a bad first-regime date before writing the account", async () => {
      const response = await create({
        name: "Bad date",
        type: "brokerage",
        currency: "EUR",
        taxRegime: "self_declared",
        taxRegimeValidFrom: "2026-02-30",
        domesticWithholdingAgent: false,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "invalid_date");
      assert.ok(!(await accountNames()).includes("Bad date"));
    });

    it("creates a brokerage account with its first regime, from today by default", async () => {
      const created = await create({
        name: "IT broker",
        type: "brokerage",
        currency: "EUR",
        taxRegime: "administered",
        domesticWithholdingAgent: true,
      });
      assert.equal(created.statusCode, 201);
      const account = created.json();
      assert.equal(account.domesticWithholdingAgent, true);

      const { rows } = await superuserPool.query<{ today: string }>(
        "SELECT to_char(now() AT TIME ZONE time_zone, 'YYYY-MM-DD') AS today FROM workspaces WHERE id = $1",
        [workspaceId],
      );
      const listed = await history(account.id);
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(listed.json(), { taxRegimes: [{ validFrom: rows[0]!.today, regime: "administered" }] });
    });

    it("creates a brokerage account whose first regime starts on a given date, then records changes on 1 January", async () => {
      const created = await create({
        name: "IT dossier",
        type: "brokerage",
        currency: "EUR",
        taxRegime: "self_declared",
        taxRegimeValidFrom: "2024-03-15",
        domesticWithholdingAgent: true,
      });
      assert.equal(created.statusCode, 201);
      const accountId = created.json().id;

      const change = await addRegime(accountId, { validFrom: "2027-01-01", regime: "managed" });
      assert.equal(change.statusCode, 201);
      assert.deepEqual(change.json(), { validFrom: "2027-01-01", regime: "managed" });

      const midYear = await addRegime(accountId, { validFrom: "2028-07-01", regime: "administered" });
      assert.equal(midYear.statusCode, 400);
      assert.deepEqual(midYear.json(), { error: "tax_regime_change_not_year_start", details: { validFrom: "2028-07-01" } });

      const duplicate = await addRegime(accountId, { validFrom: "2027-01-01", regime: "administered" });
      assert.equal(duplicate.statusCode, 400);
      assert.equal(duplicate.json().error, "tax_regime_duplicate_date");

      const badDate = await addRegime(accountId, { validFrom: "2029-02-30", regime: "administered" });
      assert.equal(badDate.statusCode, 400);
      assert.equal(badDate.json().error, "invalid_date");

      const listed = await history(accountId);
      assert.deepEqual(listed.json().taxRegimes, [
        { validFrom: "2024-03-15", regime: "self_declared" },
        { validFrom: "2027-01-01", regime: "managed" },
      ]);
    });

    it("corrects the whole history at once, which then decides earlier dates", async () => {
      const created = await create({
        name: "Corrected",
        type: "brokerage",
        currency: "EUR",
        taxRegime: "administered",
        taxRegimeValidFrom: "2024-03-15",
        domesticWithholdingAgent: true,
      });
      const accountId = created.json().id;
      const corrected = [
        { validFrom: "2024-01-01", regime: "administered" },
        { validFrom: "2015-06-01", regime: "self_declared" },
      ];

      const replaced = await replaceHistory(accountId, corrected);
      assert.equal(replaced.statusCode, 200);
      const expected = [
        { validFrom: "2015-06-01", regime: "self_declared" },
        { validFrom: "2024-01-01", regime: "administered" },
      ];
      assert.deepEqual(replaced.json(), { taxRegimes: expected });
      const stored = (await history(accountId)).json().taxRegimes as TaxRegimeEntry[];
      assert.deepEqual(stored, expected);
      assert.equal(regimeAt(stored, "2019-05-10"), "self_declared");
      assert.equal(regimeAt(stored, "2010-01-01"), "self_declared");
      assert.equal(regimeAt(stored, "2025-05-10"), "administered");

      for (const [taxRegimes, code] of [
        [[...corrected, { validFrom: "2025-07-01", regime: "managed" }], "tax_regime_change_not_year_start"],
        [[corrected[0], { validFrom: "2024-01-01", regime: "managed" }], "tax_regime_duplicate_date"],
        [[], "tax_regime_required"],
      ] as const) {
        const refused = await replaceHistory(accountId, taxRegimes);
        assert.equal(refused.statusCode, 400, code);
        assert.equal(refused.json().error, code);
      }
      for (const malformed of ["no", [{ validFrom: "2015-06-01" }], [{ validFrom: 2015, regime: "managed" }]]) {
        assert.equal((await replaceHistory(accountId, malformed)).statusCode, 400, JSON.stringify(malformed));
      }
      assert.deepEqual((await history(accountId)).json().taxRegimes, expected);
    });

    it("refuses the Italian settings in a workspace whose tax country is not IT", async () => {
      await setTaxCountry(null);
      try {
        const refused = await create({
          name: "No country",
          type: "brokerage",
          currency: "EUR",
          taxRegime: "managed",
          domesticWithholdingAgent: true,
        });
        assert.equal(refused.statusCode, 400);
        assert.deepEqual(refused.json(), { error: "tax_regime_not_applicable", details: { field: "taxRegime", taxCountry: "" } });
        const added = await addRegime(legacyBrokerageId, { validFrom: "2026-01-01", regime: "self_declared" });
        assert.equal(added.statusCode, 400);
        assert.equal(added.json().error, "tax_regime_not_applicable");
        const flag = await setFlag(legacyBrokerageId, true);
        assert.equal(flag.statusCode, 400);
        assert.equal(flag.json().error, "tax_regime_not_applicable");
      } finally {
        await setTaxCountry("IT");
      }
      assert.ok(!(await accountNames()).includes("No country"));
      assert.deepEqual((await history(legacyBrokerageId)).json(), { taxRegimes: [] });
    });

    it("rejects a tax setting on an account that is not a brokerage account", async () => {
      const withRegime = await create({ name: "Checking regime", type: "checking", currency: "EUR", taxRegime: "administered" });
      assert.equal(withRegime.statusCode, 400);
      assert.deepEqual(withRegime.json(), {
        error: "tax_regime_not_applicable",
        details: { field: "taxRegime", type: "checking" },
      });

      const withFlag = await create({ name: "Savings flag", type: "savings", currency: "EUR", domesticWithholdingAgent: false });
      assert.equal(withFlag.statusCode, 400);
      assert.equal(withFlag.json().error, "tax_regime_not_applicable");
      assert.equal(withFlag.json().details.field, "domesticWithholdingAgent");

      const checking = await create({ name: "Plain checking", type: "checking", currency: "EUR" });
      assert.equal(checking.statusCode, 201);
      assert.equal(checking.json().domesticWithholdingAgent, null);
      const added = await addRegime(checking.json().id, { validFrom: "2026-01-01", regime: "managed" });
      assert.equal(added.statusCode, 400);
      assert.equal(added.json().error, "tax_regime_not_applicable");
      const flag = await setFlag(checking.json().id, true);
      assert.equal(flag.statusCode, 400);
      assert.equal(flag.json().error, "tax_regime_not_applicable");

      const names = await accountNames();
      assert.ok(!names.includes("Checking regime") && !names.includes("Savings flag"));
    });

    it("rejects a malformed regime, date or flag", async () => {
      for (const payload of [
        { taxRegime: "flat", domesticWithholdingAgent: true },
        { taxRegime: "administered", domesticWithholdingAgent: "yes" },
        { taxRegimeValidFrom: "2026-01-01", domesticWithholdingAgent: true },
      ]) {
        const response = await create({ name: "Malformed", type: "brokerage", currency: "EUR", ...payload });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
      }
      const badRegime = await addRegime(legacyBrokerageId, { validFrom: "2026-01-01", regime: "flat" });
      assert.equal(badRegime.statusCode, 400);
      assert.equal((await setFlag(legacyBrokerageId, "yes")).statusCode, 400);
      assert.ok(!(await accountNames()).includes("Malformed"));
    });

    it("sets the flag once on a brokerage account created before the tax country, then takes its regime", async () => {
      assert.ok((await accountNames()).includes("Broker before IT"));
      assert.deepEqual((await history(legacyBrokerageId)).json(), { taxRegimes: [] });

      const tooEarly = await addRegime(legacyBrokerageId, { validFrom: "2025-09-10", regime: "administered" });
      assert.equal(tooEarly.statusCode, 400);
      assert.equal(tooEarly.json().error, "tax_regime_requires_withholding_agent");

      const flag = await setFlag(legacyBrokerageId, true);
      assert.equal(flag.statusCode, 200);
      assert.equal(flag.json().domesticWithholdingAgent, true);
      const again = await setFlag(legacyBrokerageId, false);
      assert.equal(again.statusCode, 400);
      assert.equal(again.json().error, "withholding_agent_already_set");

      const first = await addRegime(legacyBrokerageId, { validFrom: "2025-09-10", regime: "administered" });
      assert.equal(first.statusCode, 201);
      assert.deepEqual((await history(legacyBrokerageId)).json().taxRegimes, [{ validFrom: "2025-09-10", regime: "administered" }]);
    });

    it("answers 404 for a malformed account id, an unknown one, or another workspace's account, writing nothing", async () => {
      const valid = [{ validFrom: "2026-01-01", regime: "managed" }];
      for (const accountId of ["not-a-uuid", "00000000-0000-4000-8000-000000000000", otherAccountId]) {
        assert.equal((await history(accountId)).statusCode, 404, accountId);
        assert.equal((await addRegime(accountId, { validFrom: "2027-01-01", regime: "managed" })).statusCode, 404, accountId);
        assert.equal((await replaceHistory(accountId, valid)).statusCode, 404, accountId);
        assert.equal((await setFlag(accountId, true)).statusCode, 404, accountId);
      }
      const { rows } = await superuserPool.query(
        "SELECT to_char(valid_from, 'YYYY-MM-DD') AS valid_from, regime FROM account_tax_regimes WHERE account_id = $1",
        [otherAccountId],
      );
      assert.deepEqual(rows, [{ valid_from: "2020-05-05", regime: "administered" }]);
    });

    it("lets an editor change the history", async () => {
      const headers = { authorization: `Bearer ${await memberToken("editor")}` };
      const created = await create({
        name: "Edited",
        type: "brokerage",
        currency: "EUR",
        taxRegime: "self_declared",
        taxRegimeValidFrom: "2023-04-04",
        domesticWithholdingAgent: true,
      });
      const accountId = created.json().id;
      const added = await addRegime(accountId, { validFrom: "2026-01-01", regime: "administered" }, headers);
      assert.equal(added.statusCode, 201);
      const replaced = await replaceHistory(accountId, [{ validFrom: "2023-04-04", regime: "self_declared" }], headers);
      assert.equal(replaced.statusCode, 200);
    });

    it("lets a read-only member read the history but not change it", async () => {
      const headers = { authorization: `Bearer ${await memberToken("read_only")}` };
      const listed = await history(legacyBrokerageId, headers);
      assert.equal(listed.statusCode, 200);

      assert.equal((await addRegime(legacyBrokerageId, { validFrom: "2030-01-01", regime: "managed" }, headers)).statusCode, 403);
      assert.equal((await replaceHistory(legacyBrokerageId, [], headers)).statusCode, 403);
      assert.equal((await setFlag(legacyBrokerageId, false, headers)).statusCode, 403);
      assert.deepEqual((await history(legacyBrokerageId)).json(), listed.json());
    });
  });

  describe("closing an account that is not empty (#703)", () => {
    /** A workspace of its own, so its trades can go before the instrument they reference. */
    let closeWorkspaceId: string;
    let categoryId: string;
    const instrumentIds: string[] = [];
    const units = (value: number): number => Math.round(value * 1e8);
    const price = (value: number): number => Math.round(value * 1e6);
    const auth = () => ({ authorization: `Bearer ${token}` });
    /** A year that is always after today, wherever the workspace's time zone puts today. */
    const nextYear = new Date().getUTCFullYear() + 1;

    /** A refusal's details: an empty account's, with `changes` applied. */
    function details(changes: Record<string, unknown>): Record<string, unknown> {
      return { balanceCents: 0, laterRows: { count: 0, firstDate: null }, holdsPositions: false, scheduled: { count: 0, scheduledTransactionId: null, nextDueDate: null }, ...changes };
    }

    async function inject(method: "GET" | "POST" | "PATCH", path: string, payload?: Record<string, unknown>, headers = auth()) {
      return app.fastify.inject({
        method,
        url: `/workspaces/${closeWorkspaceId}${path}`,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
    }

    async function account(type: "checking" | "brokerage"): Promise<string> {
      const response = await inject("POST", "/accounts", { name: `Account ${randomUUID().slice(0, 8)}`, type, currency: "EUR" });
      assert.equal(response.statusCode, 201, response.body);
      return response.json().id;
    }

    async function transaction(accountId: string, occurredAt: string, amountCents: number): Promise<void> {
      const response = await inject("POST", `/accounts/${accountId}/transactions`, { occurredAt, splits: [{ categoryId, amountCents }] });
      assert.equal(response.statusCode, 201, response.body);
    }

    async function trade(payload: Record<string, unknown>): Promise<void> {
      const response = await inject("POST", "/trades", payload);
      assert.equal(response.statusCode, 201, response.body);
    }

    async function close(accountId: string, headers = auth()) {
      return inject("PATCH", `/accounts/${accountId}/close`, undefined, headers);
    }

    async function closedAt(accountId: string): Promise<Date | null> {
      const { rows } = await superuserPool.query<{ closed_at: Date | null }>("SELECT closed_at FROM accounts WHERE id = $1", [accountId]);
      return rows[0]!.closed_at;
    }

    /** A brokerage account, a portfolio and an instrument to trade in it. */
    async function brokerage(): Promise<{ accountId: string; portfolioId: string; instrumentId: string }> {
      const accountId = await account("brokerage");
      const { rows: portfolios } = await superuserPool.query<{ id: string }>(
        "INSERT INTO portfolios (workspace_id, name) VALUES ($1, $2) RETURNING id",
        [closeWorkspaceId, `Portfolio ${randomUUID()}`],
      );
      const { rows: instruments } = await superuserPool.query<{ id: string }>(
        `INSERT INTO instruments (isin, ticker, exchange, name, type, currency, price_factor_e6)
         VALUES (NULL, $1, 'XMIL', 'Test fund', 'fund', 'EUR', 1000000) RETURNING id`,
        [`T${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`],
      );
      instrumentIds.push(instruments[0]!.id);
      return { accountId, portfolioId: portfolios[0]!.id, instrumentId: instruments[0]!.id };
    }

    /** A token for a new user who is a member of this block's workspace with `role`; refreshes the owner's token after. */
    async function memberToken(role: "editor" | "read_only"): Promise<string> {
      const memberToken = await realm.getTokenForNewUser();
      await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${memberToken}` } });
      const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
        decodeJwt(memberToken).sub,
      ]);
      await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [
        rows[0]!.id,
        closeWorkspaceId,
        role,
      ]);
      token = await realm.getUserToken();
      return memberToken;
    }

    before(async () => {
      closeWorkspaceId = randomUUID();
      await superuserPool.query(
        "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Closing', 'EUR', 'Europe/Rome')",
        [closeWorkspaceId],
      );
      const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [decodeJwt(token).sub]);
      await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'owner')", [rows[0]!.id, closeWorkspaceId]);
      const group = await inject("POST", "/category-groups", { name: "Home" });
      const category = await inject("POST", "/categories", { name: "Groceries", groupId: group.json().id });
      categoryId = category.json().id;
    });

    after(async () => {
      // The trades go with their workspace; only then can the instruments they referenced go.
      await superuserPool.query("DELETE FROM workspaces WHERE id = $1", [closeWorkspaceId]);
      await superuserPool.query("DELETE FROM instruments WHERE id = ANY($1)", [instrumentIds]);
    });

    it("refuses an account with a balance, with the balance in the details, and leaves it open", async () => {
      const accountId = await account("checking");
      await transaction(accountId, "2026-09-01", 10_000);
      await transaction(accountId, "2026-09-02", -2_550);

      const response = await close(accountId);
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { error: "account_not_empty", details: details({ balanceCents: 7_450 }) });
      assert.equal(await closedAt(accountId), null);
    });

    it("refuses an account with a balance today that a later row would cancel, naming the later rows (#729)", async () => {
      const accountId = await account("checking");
      await transaction(accountId, "2026-09-01", 1_000);
      await transaction(accountId, `${nextYear}-03-01`, -1_000);
      await transaction(accountId, `${nextYear}-02-01`, 0);

      const response = await close(accountId);
      assert.equal(response.statusCode, 409);
      // Today's balance, the figure on screen, not the zero over all dates.
      assert.deepEqual(response.json().details, details({ balanceCents: 1_000, laterRows: { count: 2, firstDate: `${nextYear}-02-01` } }));
      assert.equal(await closedAt(accountId), null);
    });

    it("refuses an account empty today with a row dated later, quoting a balance of zero (#729)", async () => {
      const accountId = await account("checking");
      await transaction(accountId, `${nextYear + 1}-01-15`, -2_500);

      const response = await close(accountId);
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json().details, details({ laterRows: { count: 1, firstDate: `${nextYear + 1}-01-15` } }));
      assert.equal(await closedAt(accountId), null);
    });

    it("closes an account whose rows up to today add up to zero and that has none later", async () => {
      const accountId = await account("checking");
      await transaction(accountId, "2026-09-01", 10_000);
      await transaction(accountId, "2026-09-03", -10_000);

      const response = await close(accountId);
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.json().closedAt);
    });

    it("closes an account with no rows at all", async () => {
      const response = await close(await account("checking"));
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.json().closedAt);
    });

    it("refuses an account a scheduled transaction uses, with how many and the one due first (#729, #741)", async () => {
      const accountId = await account("checking");
      const ids = new Map<string, string[]>();
      // Created out of order, and two due on the same first date: the earliest date wins, then the lowest id.
      for (const nextDueDate of [`${nextYear}-06-01`, `${nextYear}-02-15`, `${nextYear}-02-15`]) {
        const scheduled = await inject("POST", "/scheduled-transactions", {
          accountId,
          nextDueDate,
          recurEvery: 1,
          recurUnit: "year",
          splits: [{ categoryId, amountCents: 100 }],
        });
        assert.equal(scheduled.statusCode, 201, scheduled.body);
        ids.set(nextDueDate, [...(ids.get(nextDueDate) ?? []), scheduled.json().id as string]);
      }
      const first = [...ids.get(`${nextYear}-02-15`)!].sort()[0];

      const response = await close(accountId);
      assert.equal(response.statusCode, 409);
      assert.deepEqual(
        response.json().details,
        details({ scheduled: { count: 3, scheduledTransactionId: first, nextDueDate: `${nextYear}-02-15` } }),
      );
      assert.equal(await closedAt(accountId), null);
    });

    it("gives null for the first schedule when none uses the account (#741)", async () => {
      const accountId = await account("checking");
      await transaction(accountId, "2020-01-15T12:00:00Z", 500);

      const response = await close(accountId);
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json().details.scheduled, { count: 0, scheduledTransactionId: null, nextDueDate: null });
    });

    it("refuses a brokerage account that holds securities and no cash", async () => {
      const { accountId, portfolioId, instrumentId } = await brokerage();
      // Units transferred in from outside the app: a position, and no cash leg.
      await trade({ type: "transfer", instrumentId, tradeDate: "2026-02-10", quantityE8: units(10), to: { accountId, portfolioId, costBasisCents: 100_000 } });

      const response = await close(accountId);
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { error: "account_not_empty", details: details({ holdsPositions: true }) });
      assert.equal(await closedAt(accountId), null);
    });

    it("refuses a brokerage account that holds a unit today and sells it at a later date (#729)", async () => {
      const { accountId, portfolioId, instrumentId } = await brokerage();
      await trade({ type: "transfer", instrumentId, tradeDate: "2026-02-10", quantityE8: units(1), to: { accountId, portfolioId, costBasisCents: 5_000 } });
      // Sold later, its proceeds moved out the same day: over all dates the account ends empty.
      const sale = { accountId, portfolioId, instrumentId, quantityE8: units(1), priceE6: price(50) };
      await trade({ ...sale, type: "sell", tradeDate: `${nextYear}-04-01` });
      const other = await account("checking");
      const moved = await inject("POST", "/transfers", {
        sourceAccountId: accountId,
        destinationAccountId: other,
        occurredAt: `${nextYear}-04-01`,
        amountCents: 5_000,
      });
      assert.equal(moved.statusCode, 201, moved.body);

      const response = await close(accountId);
      assert.equal(response.statusCode, 409);
      assert.deepEqual(
        response.json().details,
        details({ holdsPositions: true, laterRows: { count: 2, firstDate: `${nextYear}-04-01` } }),
      );
      assert.equal(await closedAt(accountId), null);
    });

    it("counts a later trade that moves no cash as a later row (#729)", async () => {
      const { accountId, portfolioId, instrumentId } = await brokerage();
      await trade({ type: "transfer", instrumentId, tradeDate: `${nextYear}-05-02`, quantityE8: units(1), to: { accountId, portfolioId, costBasisCents: 5_000 } });

      const response = await close(accountId);
      assert.equal(response.statusCode, 409);
      // No unit is held today: the transfer in is dated later.
      assert.deepEqual(response.json().details, details({ laterRows: { count: 1, firstDate: `${nextYear}-05-02` } }));
    });

    it("closes a brokerage account whose positions are sold out and whose cash adds up to zero", async () => {
      const { accountId, portfolioId, instrumentId } = await brokerage();
      const common = { accountId, portfolioId, instrumentId, quantityE8: units(2), priceE6: price(50) };
      await trade({ ...common, type: "buy", tradeDate: "2026-03-02" });
      await trade({ ...common, type: "sell", tradeDate: "2026-03-03" });

      // The position sold out is still listed, with quantity zero: it does not hold the account open.
      const positions = await inject("GET", `/accounts/${accountId}/positions`);
      assert.equal(positions.statusCode, 200, positions.body);
      const listed = (positions.json() as { positions: { instrument: { id: string }; quantityE8: number }[] }).positions;
      assert.deepEqual(
        listed.map((position) => ({ instrumentId: position.instrument.id, quantityE8: position.quantityE8 })),
        [{ instrumentId, quantityE8: 0 }],
      );

      const response = await close(accountId);
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.json().closedAt);
    });

    it("gives an editor the same refusal and lets an editor close an empty account", async () => {
      const headers = { authorization: `Bearer ${await memberToken("editor")}` };
      const withMoney = await account("checking");
      await transaction(withMoney, "2026-09-01", 1);
      const empty = await account("checking");

      const refused = await close(withMoney, headers);
      assert.equal(refused.statusCode, 409);
      assert.deepEqual(refused.json().details, details({ balanceCents: 1 }));

      const closed = await close(empty, headers);
      assert.equal(closed.statusCode, 200, closed.body);
    });

    it("refuses a read-only member with 403, empty account or not, closing nothing", async () => {
      const headers = { authorization: `Bearer ${await memberToken("read_only")}` };
      const withMoney = await account("checking");
      await transaction(withMoney, "2026-09-01", 500);
      const empty = await account("checking");

      for (const accountId of [withMoney, empty]) {
        assert.equal((await close(accountId, headers)).statusCode, 403);
        assert.equal(await closedAt(accountId), null);
      }
    });
  });
});
