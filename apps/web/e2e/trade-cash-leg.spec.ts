import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * A trade's cash leg in a brokerage account's register (#657): a buy recorded through the API
 * reads as its trade, and its memo is edited from the web while its amount stays with the trade.
 * Needs `apps/api` and Keycloak already running, or a disposable environment; see `e2e/README.md`.
 */
test.describe("a trade's cash leg (#657)", () => {
  async function signIn(page: Page, user: Awaited<ReturnType<typeof createTestUser>>) {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/realms\/[^/]+\/protocol\/openid-connect\/auth/);
    await page.getByLabel("Username or email").fill(user.username);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
  }

  /** POSTs as the signed-in user, with the API address and token the web app itself uses. */
  async function post(request: APIRequestContext, api: { base: string; authorization: string }, path: string, data: Record<string, unknown>) {
    const response = await request.post(`${api.base}${path}`, { headers: { authorization: api.authorization }, data });
    expect(response.status(), `${path}: ${await response.text()}`).toBe(201);
    return (await response.json()) as Record<string, unknown>;
  }

  test("shows a buy recorded through the API as its trade, and edits its memo from the web", async ({ page, request }) => {
    const user = await createTestUser();
    let workspace: Awaited<ReturnType<typeof createWorkspaceWithMembership>> | undefined;
    try {
      await signIn(page, user);
      await expect(page.getByText("You do not belong to any workspace yet.")).toBeVisible();
      const userId = await findUserIdBySubject(user.subject);
      if (!userId) {
        throw new Error("expected a local user row for this subject after sign-in");
      }
      workspace = await createWorkspaceWithMembership(userId, "Investments");

      // The web app's own request to the workspace gives the API's address and the user's token.
      const workspaceRequest = page.waitForRequest((r) => r.url().includes(`/workspaces/${workspace!.id}/`) && r.headers()["authorization"] !== undefined);
      await page.goto("/");
      await page.waitForURL(`/${workspace.id}`);
      const seen = await workspaceRequest;
      const api = { base: seen.url().slice(0, seen.url().indexOf(`/workspaces/${workspace.id}/`)), authorization: seen.headers()["authorization"]! };

      const ws = `/workspaces/${workspace.id}`;
      const broker = await post(request, api, `${ws}/accounts`, { name: "Broker", type: "brokerage", currency: "EUR" });
      const portfolio = await post(request, api, `${ws}/portfolios`, { name: "Long term" });
      const fund = await post(request, api, `${ws}/instruments`, { name: "World equity fund", type: "fund", currency: "EUR", assetClass: "Equity" });
      await post(request, api, `${ws}/trades`, {
        type: "buy",
        accountId: broker.id,
        portfolioId: portfolio.id,
        instrumentId: fund.id,
        tradeDate: "2026-01-12",
        quantityE8: 10 * 100_000_000,
        priceE6: 100 * 1_000_000,
      });

      await page.goto(`/${workspace.id}/accounts/${broker.id as string}`);
      await expect(page.getByRole("heading", { name: "Broker" })).toBeVisible();
      const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Buy · 10 × World equity fund" }) });
      await expect(row).toBeVisible();
      await expect(row.getByRole("cell", { name: "1,000.00", exact: true })).toBeVisible();

      await row.getByRole("button", { name: "Buy · 10 × World equity fund" }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet.getByLabel("Amount")).toBeDisabled();
      await expect(sheet.getByText("Change it on the trade.")).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Delete" })).toHaveCount(0);
      await sheet.getByLabel("Memo").fill("Monthly plan");
      await sheet.getByRole("button", { name: "Save" }).click();
      await expect(sheet).not.toBeVisible();

      await expect(row.getByText("Monthly plan")).toBeVisible();
      await expect(row.getByRole("cell", { name: "1,000.00", exact: true })).toBeVisible();
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
