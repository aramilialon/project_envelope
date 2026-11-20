import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { MAX_NAME_LENGTH } from "@envelope/core";
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
    /** A brokerage account created before the workspace's tax country was set: no regime at all. */
    let legacyBrokerageId: string;

    async function create(payload: Record<string, unknown>) {
      return app.fastify.inject({ method: "POST", url: `/workspaces/${workspaceId}/accounts`, headers: auth(), payload });
    }

    async function accountNames(): Promise<string[]> {
      const listed = await app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts`, headers: auth() });
      return listed.json().accounts.map((a: { name: string }) => a.name);
    }

    async function history(accountId: string, headers = auth()) {
      return app.fastify.inject({ method: "GET", url: `/workspaces/${workspaceId}/accounts/${accountId}/tax-regimes`, headers });
    }

    async function addRegime(accountId: string, payload: Record<string, unknown>, headers = auth()) {
      return app.fastify.inject({
        method: "POST",
        url: `/workspaces/${workspaceId}/accounts/${accountId}/tax-regimes`,
        headers,
        payload,
      });
    }

    /** A token for a new user who is a read_only member of the workspace. */
    async function readOnlyMemberToken(): Promise<string> {
      const readOnlyToken = await realm.getTokenForNewUser();
      await app.fastify.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${readOnlyToken}` } });
      const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
        decodeJwt(readOnlyToken).sub,
      ]);
      await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'read_only')", [
        rows[0]!.id,
        workspaceId,
      ]);
      return readOnlyToken;
    }

    // The test realm's access tokens live 3 seconds (test-helpers/keycloak.ts): take a fresh one
    // before each test rather than rely on the one the file's setup obtained.
    beforeEach(async () => {
      token = await realm.getUserToken();
    });

    before(async () => {
      token = await realm.getUserToken();
      const legacy = await create({ name: "Broker before IT", type: "brokerage", currency: "EUR" });
      assert.equal(legacy.statusCode, 201);
      legacyBrokerageId = legacy.json().id;

      const setCountry = await app.fastify.inject({
        method: "PATCH",
        url: `/workspaces/${workspaceId}`,
        headers: auth(),
        payload: { taxCountry: "IT" },
      });
      assert.equal(setCountry.statusCode, 200);
    });

    after(async () => {
      await superuserPool.query("UPDATE workspaces SET tax_country = NULL WHERE id = $1", [workspaceId]);
    });

    it("requires a regime and the withholding-agent flag on a brokerage account in an IT workspace, storing nothing", async () => {
      const noRegime = await create({ name: "IT no regime", type: "brokerage", currency: "EUR", domesticWithholdingAgent: true });
      assert.equal(noRegime.statusCode, 400);
      assert.deepEqual(noRegime.json(), { error: "tax_regime_required", details: { field: "taxRegime", taxCountry: "IT" } });

      const noFlag = await create({ name: "IT no flag", type: "brokerage", currency: "EUR", taxRegime: "administered" });
      assert.equal(noFlag.statusCode, 400);
      assert.equal(noFlag.json().error, "tax_regime_required");
      assert.equal(noFlag.json().details.field, "domesticWithholdingAgent");

      const names = await accountNames();
      assert.ok(!names.includes("IT no regime") && !names.includes("IT no flag"));
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
        name: "IT foreign broker",
        type: "brokerage",
        currency: "EUR",
        taxRegime: "self_declared",
        taxRegimeValidFrom: "2024-03-15",
        domesticWithholdingAgent: false,
      });
      assert.equal(created.statusCode, 201);
      const accountId = created.json().id;
      assert.equal(created.json().domesticWithholdingAgent, false);

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
      assert.ok(!(await accountNames()).includes("Malformed"));
    });

    it("keeps a brokerage account created before the tax country was set, with no regime, until one is added", async () => {
      assert.ok((await accountNames()).includes("Broker before IT"));
      assert.deepEqual((await history(legacyBrokerageId)).json(), { taxRegimes: [] });

      const first = await addRegime(legacyBrokerageId, { validFrom: "2025-09-10", regime: "administered" });
      assert.equal(first.statusCode, 201);
      assert.deepEqual((await history(legacyBrokerageId)).json().taxRegimes, [{ validFrom: "2025-09-10", regime: "administered" }]);
    });

    it("answers 404 for an account in no workspace of the caller's", async () => {
      const missing = "00000000-0000-4000-8000-000000000000";
      assert.equal((await history(missing)).statusCode, 404);
      assert.equal((await addRegime(missing, { validFrom: "2026-01-01", regime: "managed" })).statusCode, 404);
    });

    it("lets a read-only member read the history but not change it", async () => {
      const headers = { authorization: `Bearer ${await readOnlyMemberToken()}` };
      // Creating that user can take long enough for the owner's token to expire.
      token = await realm.getUserToken();
      const listed = await history(legacyBrokerageId, headers);
      assert.equal(listed.statusCode, 200);

      const refused = await addRegime(legacyBrokerageId, { validFrom: "2030-01-01", regime: "managed" }, headers);
      assert.equal(refused.statusCode, 403);
      assert.equal((await history(legacyBrokerageId)).json().taxRegimes.length, listed.json().taxRegimes.length);
    });
  });
});
