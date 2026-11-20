import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { decodeJwt } from "jose";

import { type App } from "../app.ts";
import { type DbPool } from "../db/pool.ts";
import { type KeycloakTestRealm } from "../test-helpers/keycloak.ts";
import { setupIntegrationTest, teardownIntegrationTest } from "../test-helpers/integration-setup.ts";

describe("portfolios routes (#75)", () => {
  let superuserPool: DbPool;
  let realm: KeycloakTestRealm;
  let app: App;
  let workspaceId: string;
  let token: string;
  let userId: string;
  const otherWorkspaceIds: string[] = [];

  const auth = () => ({ authorization: `Bearer ${token}` });
  const url = (path = "", ws = workspaceId) => `/workspaces/${ws}/portfolios${path}`;

  async function create(payload: Record<string, unknown>, ws = workspaceId) {
    return app.fastify.inject({ method: "POST", url: url("", ws), headers: auth(), payload });
  }

  async function patch(id: string, payload: Record<string, unknown>, ws = workspaceId) {
    return app.fastify.inject({ method: "PATCH", url: url(`/${id}`, ws), headers: auth(), payload });
  }

  /** Another workspace, with the test user as `role` in it, or not a member at all. */
  async function addWorkspace(role?: "owner" | "editor" | "read_only"): Promise<string> {
    const id = randomUUID();
    otherWorkspaceIds.push(id);
    await superuserPool.query(
      "INSERT INTO workspaces (id, name, base_currency, time_zone) VALUES ($1, 'Other', 'EUR', 'Europe/Rome')",
      [id],
    );
    if (role) {
      await superuserPool.query("INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)", [userId, id, role]);
    }
    return id;
  }

  before(async () => {
    ({ superuserPool, realm, app, workspaceId, token } = await setupIntegrationTest());
    const { rows } = await superuserPool.query<{ id: string }>("SELECT id FROM users WHERE keycloak_subject = $1", [
      decodeJwt(token).sub,
    ]);
    userId = rows[0]!.id;
  });

  after(async () => {
    await superuserPool.query("DELETE FROM workspaces WHERE id = ANY($1)", [otherWorkspaceIds]);
    await teardownIntegrationTest({ superuserPool, realm, app, workspaceId, token });
  });

  it("rejects a request with no token", async () => {
    const response = await app.fastify.inject({ method: "GET", url: url() });
    assert.equal(response.statusCode, 401);
  });

  it("creates, gets, lists, updates and deletes a portfolio", async () => {
    const created = await create({ name: "  Retirement ", purpose: " Long term " });
    assert.equal(created.statusCode, 201);
    const portfolio = created.json();
    assert.equal(portfolio.name, "Retirement");
    assert.equal(portfolio.purpose, "Long term");
    assert.equal(portfolio.archivedAt, null);
    assert.equal(portfolio.workspaceId, workspaceId);

    const fetched = await app.fastify.inject({ method: "GET", url: url(`/${portfolio.id}`), headers: auth() });
    assert.equal(fetched.statusCode, 200);
    assert.deepEqual(fetched.json(), portfolio);

    const listed = await app.fastify.inject({ method: "GET", url: url(), headers: auth() });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json().portfolios.some((p: { id: string }) => p.id === portfolio.id));

    const renamed = await patch(portfolio.id, { name: "Pension", purpose: "Retirement income" });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().name, "Pension");
    assert.equal(renamed.json().purpose, "Retirement income");

    const purposeCleared = await patch(portfolio.id, { purpose: null });
    assert.equal(purposeCleared.statusCode, 200);
    assert.equal(purposeCleared.json().purpose, null);
    assert.equal(purposeCleared.json().name, "Pension");

    const deleted = await app.fastify.inject({ method: "DELETE", url: url(`/${portfolio.id}`), headers: auth() });
    assert.equal(deleted.statusCode, 204);

    const gone = await app.fastify.inject({ method: "GET", url: url(`/${portfolio.id}`), headers: auth() });
    assert.equal(gone.statusCode, 404);
    const deletedAgain = await app.fastify.inject({ method: "DELETE", url: url(`/${portfolio.id}`), headers: auth() });
    assert.equal(deletedAgain.statusCode, 404);
  });

  it("creates a portfolio with no purpose", async () => {
    const created = await create({ name: "No purpose" });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().purpose, null);
  });

  it("stores a whitespace-only purpose as none, on create and on update", async () => {
    const created = await create({ name: "Blank purpose", purpose: "   " });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().purpose, null);

    await patch(created.json().id, { purpose: "Something" });
    const cleared = await patch(created.json().id, { purpose: " \t " });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().purpose, null);

    const { rows } = await superuserPool.query("SELECT purpose FROM portfolios WHERE id = $1", [created.json().id]);
    assert.deepEqual(rows, [{ purpose: null }]);
  });

  it("lists portfolios by name ignoring case, then by creation time", async () => {
    const orderedWorkspace = await addWorkspace("owner");
    const beta = (await create({ name: "beta" }, orderedWorkspace)).json();
    const oldAlpha = (await create({ name: "alpha" }, orderedWorkspace)).json();
    const charlie = (await create({ name: "Charlie" }, orderedWorkspace)).json();
    await patch(oldAlpha.id, { archived: true }, orderedWorkspace);
    // Same name ignoring case as the archived one, created later: sorts after it.
    const newAlpha = (await create({ name: "ALPHA" }, orderedWorkspace)).json();

    const active = await app.fastify.inject({ method: "GET", url: url("", orderedWorkspace), headers: auth() });
    assert.deepEqual(
      active.json().portfolios.map((p: { id: string }) => p.id),
      [newAlpha.id, beta.id, charlie.id],
    );

    const all = await app.fastify.inject({ method: "GET", url: url("?includeArchived=true", orderedWorkspace), headers: auth() });
    assert.deepEqual(
      all.json().portfolios.map((p: { id: string }) => p.id),
      [oldAlpha.id, newAlpha.id, beta.id, charlie.id],
    );
  });

  it("refuses an invalid body, and answers 404 for an unknown or malformed id", async () => {
    assert.equal((await create({ name: "   " })).statusCode, 400);
    assert.equal((await create({ purpose: "Only a purpose" })).statusCode, 400);
    assert.equal((await create({ name: "Bad purpose", purpose: 42 })).statusCode, 400);

    const portfolio = (await create({ name: "Validated" })).json();
    assert.equal((await patch(portfolio.id, {})).statusCode, 400);
    assert.equal((await patch(portfolio.id, { name: "" })).statusCode, 400);
    assert.equal((await patch(portfolio.id, { archived: "yes" })).statusCode, 400);

    assert.equal((await patch(randomUUID(), { name: "Anything" })).statusCode, 404);
    assert.equal((await patch("not-a-uuid", { name: "Anything" })).statusCode, 404);
    const malformedGet = await app.fastify.inject({ method: "GET", url: url("/not-a-uuid"), headers: auth() });
    assert.equal(malformedGet.statusCode, 404);
    const malformedDelete = await app.fastify.inject({ method: "DELETE", url: url("/not-a-uuid"), headers: auth() });
    assert.equal(malformedDelete.statusCode, 404);
  });

  it("archives and unarchives, leaving archived portfolios out of the list unless asked for", async () => {
    const portfolio = (await create({ name: "Archivable" })).json();

    const archived = await patch(portfolio.id, { archived: true });
    assert.equal(archived.statusCode, 200);
    assert.ok(archived.json().archivedAt);

    // Archiving again keeps the original archive time.
    const archivedAgain = await patch(portfolio.id, { archived: true });
    assert.equal(archivedAgain.json().archivedAt, archived.json().archivedAt);

    const active = await app.fastify.inject({ method: "GET", url: url(), headers: auth() });
    assert.ok(!active.json().portfolios.some((p: { id: string }) => p.id === portfolio.id));

    const all = await app.fastify.inject({ method: "GET", url: url("?includeArchived=true"), headers: auth() });
    assert.ok(all.json().portfolios.some((p: { id: string }) => p.id === portfolio.id));

    // An archived portfolio can still be read on its own.
    const fetched = await app.fastify.inject({ method: "GET", url: url(`/${portfolio.id}`), headers: auth() });
    assert.equal(fetched.statusCode, 200);

    const unarchived = await patch(portfolio.id, { archived: false });
    assert.equal(unarchived.statusCode, 200);
    assert.equal(unarchived.json().archivedAt, null);
    const activeAgain = await app.fastify.inject({ method: "GET", url: url(), headers: auth() });
    assert.ok(activeAgain.json().portfolios.some((p: { id: string }) => p.id === portfolio.id));
  });

  describe("names already in use", () => {
    it("refuses a second portfolio with the same name, whatever its case or spaces, as name_taken", async () => {
      await create({ name: "Growth" });
      const duplicate = await create({ name: " GROWTH " });
      assert.equal(duplicate.statusCode, 409);
      assert.equal(duplicate.json().code, "name_taken");

      const other = (await create({ name: "Income" })).json();
      const renamedOntoAnother = await patch(other.id, { name: "growth" });
      assert.equal(renamedOntoAnother.statusCode, 409);
      assert.equal(renamedOntoAnother.json().code, "name_taken");

      // Keeping its own name, just in another case, is not a clash with itself.
      const sameName = await patch(other.id, { name: "INCOME" });
      assert.equal(sameName.statusCode, 200);
      assert.equal(sameName.json().name, "INCOME");
    });

    it("lets an archived portfolio's name be reused, but not unarchived onto a name now taken", async () => {
      const old = (await create({ name: "Children" })).json();
      await patch(old.id, { archived: true });

      const reused = await create({ name: "children" });
      assert.equal(reused.statusCode, 201);

      const unarchived = await patch(old.id, { archived: false });
      assert.equal(unarchived.statusCode, 409);
      assert.equal(unarchived.json().code, "name_taken");

      // Renaming while unarchiving resolves it in one request.
      const renamedAndUnarchived = await patch(old.id, { archived: false, name: "Children (old)" });
      assert.equal(renamedAndUnarchived.statusCode, 200);
      assert.equal(renamedAndUnarchived.json().archivedAt, null);

      // Renaming an archived portfolio onto an active one's name is allowed while it stays archived.
      await patch(old.id, { archived: true });
      const archivedRename = await patch(old.id, { name: "Children" });
      assert.equal(archivedRename.statusCode, 200);
    });

    it("does not compare names across workspaces", async () => {
      const otherWorkspace = await addWorkspace("owner");
      await create({ name: "Shared name" });
      const sameNameElsewhere = await create({ name: "Shared name" }, otherWorkspace);
      assert.equal(sameNameElsewhere.statusCode, 201);
    });
  });

  describe("roles", () => {
    it("lets a read_only member read but not write", async () => {
      const readOnlyWorkspace = await addWorkspace("read_only");
      const { rows } = await superuserPool.query<{ id: string }>(
        "INSERT INTO portfolios (workspace_id, name) VALUES ($1, 'Visible') RETURNING id",
        [readOnlyWorkspace],
      );
      const portfolioId = rows[0]!.id;

      const listed = await app.fastify.inject({ method: "GET", url: url("", readOnlyWorkspace), headers: auth() });
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(
        listed.json().portfolios.map((p: { id: string }) => p.id),
        [portfolioId],
      );
      const fetched = await app.fastify.inject({ method: "GET", url: url(`/${portfolioId}`, readOnlyWorkspace), headers: auth() });
      assert.equal(fetched.statusCode, 200);

      assert.equal((await create({ name: "Nope" }, readOnlyWorkspace)).statusCode, 403);
      assert.equal((await patch(portfolioId, { name: "Nope" }, readOnlyWorkspace)).statusCode, 403);
      assert.equal((await patch(portfolioId, { archived: true }, readOnlyWorkspace)).statusCode, 403);
      const deleted = await app.fastify.inject({ method: "DELETE", url: url(`/${portfolioId}`, readOnlyWorkspace), headers: auth() });
      assert.equal(deleted.statusCode, 403);

      const unchanged = await superuserPool.query("SELECT name, archived_at FROM portfolios WHERE id = $1", [portfolioId]);
      assert.deepEqual(unchanged.rows, [{ name: "Visible", archived_at: null }]);
    });

    it("lets an editor create, update and delete", async () => {
      const editorWorkspace = await addWorkspace("editor");
      const created = await create({ name: "Edited" }, editorWorkspace);
      assert.equal(created.statusCode, 201);
      const updated = await patch(created.json().id, { name: "Edited again", archived: true }, editorWorkspace);
      assert.equal(updated.statusCode, 200);
      const deleted = await app.fastify.inject({
        method: "DELETE",
        url: url(`/${created.json().id}`, editorWorkspace),
        headers: auth(),
      });
      assert.equal(deleted.statusCode, 204);
    });
  });

  describe("workspace isolation", () => {
    let foreignWorkspace: string;
    let foreignPortfolioId: string;

    before(async () => {
      // A workspace the test user is not a member of at all.
      foreignWorkspace = await addWorkspace();
      const { rows } = await superuserPool.query<{ id: string }>(
        "INSERT INTO portfolios (workspace_id, name) VALUES ($1, 'Not mine') RETURNING id",
        [foreignWorkspace],
      );
      foreignPortfolioId = rows[0]!.id;
    });

    it("refuses every request naming a workspace the caller is not a member of", async () => {
      const listed = await app.fastify.inject({ method: "GET", url: url("", foreignWorkspace), headers: auth() });
      assert.equal(listed.statusCode, 403);
      assert.equal((await create({ name: "Sneaky" }, foreignWorkspace)).statusCode, 403);
    });

    it("cannot read, update or delete another workspace's portfolio through its own workspace", async () => {
      const fetched = await app.fastify.inject({ method: "GET", url: url(`/${foreignPortfolioId}`), headers: auth() });
      assert.equal(fetched.statusCode, 404);

      const listed = await app.fastify.inject({ method: "GET", url: url("?includeArchived=true"), headers: auth() });
      assert.ok(!listed.json().portfolios.some((p: { id: string }) => p.id === foreignPortfolioId));

      assert.equal((await patch(foreignPortfolioId, { name: "Taken over", archived: true })).statusCode, 404);

      const deleted = await app.fastify.inject({ method: "DELETE", url: url(`/${foreignPortfolioId}`), headers: auth() });
      assert.equal(deleted.statusCode, 404);

      const untouched = await superuserPool.query("SELECT workspace_id, name, archived_at FROM portfolios WHERE id = $1", [
        foreignPortfolioId,
      ]);
      assert.deepEqual(untouched.rows, [{ workspace_id: foreignWorkspace, name: "Not mine", archived_at: null }]);
    });
  });
});
