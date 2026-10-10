import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * The phone tab bar's own central button (#367, `docs/ux/mockups/account-register.html`'s own
 * `qeHtml()`): records a real expense through the full keypad flow at a phone viewport, against
 * the real `POST /workspaces/:workspaceId/accounts/:accountId/transactions` endpoint. Needs
 * `apps/api` and Keycloak already running; see `e2e/README.md`.
 */
test.describe("quick expense entry (#367)", () => {
  async function signIn(page: import("@playwright/test").Page, user: Awaited<ReturnType<typeof createTestUser>>) {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/realms\/envelope\/protocol\/openid-connect\/auth/);
    await page.getByLabel("Username or email").fill(user.username);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
  }

  test("records an expense in a few taps, from the tab bar's own central button", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const user = await createTestUser();
    let workspace: Awaited<ReturnType<typeof createWorkspaceWithMembership>> | undefined;
    try {
      await signIn(page, user);
      await expect(page.getByText("You do not belong to any workspace yet.")).toBeVisible();
      const userId = await findUserIdBySubject(user.subject);
      if (!userId) {
        throw new Error("expected a local user row for this subject after sign-in");
      }

      workspace = await createWorkspaceWithMembership(userId, "Famiglia");
      await page.goto("/");
      await page.waitForURL(`/${workspace.id}`);

      // A category to spend from and an on-budget account to spend with.
      await page.getByRole("button", { name: "Famiglia" }).click();
      await page.getByRole("menuitem", { name: "Workspace settings" }).click();
      await page.waitForURL(`/${workspace.id}/settings/categories`);
      await page.getByRole("button", { name: "+ Add a group" }).click();
      await page.getByLabel("Group name").fill("Everyday");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("button", { name: "+ Add a category" }).click();
      await page.getByLabel("Category name").fill("Groceries");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByText("Groceries")).toBeVisible();

      // Below 600px both the band's own nav and the phone tab bar show the same links
      // (#331): scope to the band's, since the tab bar is exercised below for its own button.
      const nav = page.getByRole("navigation", { name: "Main", exact: true });

      await nav.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await page.getByRole("button", { name: "+ Add account" }).click();
      await page.getByLabel("Name").fill("Checking");
      await page.getByRole("dialog").getByRole("button", { name: "Add account", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      await nav.getByRole("link", { name: "Budget" }).click();
      await page.waitForURL(`/${workspace.id}`);
      await page.getByText("Groceries").waitFor();
      await page.getByRole("button", { name: "Assign", exact: true }).click();
      await page.getByRole("dialog").getByLabel("To").selectOption({ label: "Groceries (€0.00)" });
      await page.getByRole("dialog").getByLabel("Amount", { exact: true }).fill("50.00");
      await page.getByRole("dialog").getByRole("button", { name: "Assign €50.00", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await expect(page.getByText("€50.00 to spend")).toBeVisible();

      // The tab bar's own central button, reachable from the budget month like every other
      // phone screen.
      const tabbar = page.getByRole("navigation", { name: "Main, phone" });
      await tabbar.getByRole("button", { name: "New expense" }).click();
      const overlay = page.getByRole("dialog", { name: "New expense" });
      await expect(overlay).toBeVisible();

      await overlay.getByLabel("Where").fill("Supermarket");
      // Scoped to the keypad itself: a bare digit's name would otherwise also substring-match
      // other amounts on screen (Playwright's role name matching is substring by default).
      const keypad = overlay.locator(".keys");
      await keypad.getByRole("button", { name: "1", exact: true }).click();
      await keypad.getByRole("button", { name: "2", exact: true }).click();
      await keypad.getByRole("button", { name: ".", exact: true }).click();
      await keypad.getByRole("button", { name: "5", exact: true }).click();
      await keypad.getByRole("button", { name: "0", exact: true }).click();
      await overlay.getByRole("button", { name: /^Groceries/ }).click();
      await overlay.getByRole("button", { name: "Checking", exact: true }).click();
      await overlay.getByRole("button", { name: "Save €12.50", exact: true }).click();

      await expect(overlay.getByText("Expense saved")).toBeVisible();
      await expect(overlay.locator(".toast")).toHaveText(
        "€12.50 from Supermarket with Checking. Groceries now has €37.50 available.",
      );

      await overlay.getByRole("button", { name: "Close", exact: true }).click();
      await expect(overlay).not.toBeVisible();

      // Reflected in the budget month underneath, without a route change losing our place.
      await expect(page.getByRole("button", { name: /^Groceries/ })).toContainText("€12.50 spent of €50.00");
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
