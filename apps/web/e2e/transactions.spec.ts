import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * Drives a real headless Chromium through the account register (#54): reaching it from the
 * sidebar ledger, adding a plain outflow and a transfer, and toggling a transaction's status.
 * Needs `apps/api` and Keycloak already running; see `e2e/README.md`.
 */
test.describe("account register (#54)", () => {
  async function signIn(page: import("@playwright/test").Page, user: Awaited<ReturnType<typeof createTestUser>>) {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/realms\/envelope\/protocol\/openid-connect\/auth/);
    await page.getByLabel("Username or email").fill(user.username);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
  }

  test("adds an outflow and a transfer, and toggles a transaction's status", async ({ page }) => {
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

      // A category for the outflow to use.
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

      // Two accounts, so the transfer form has a real destination to pick.
      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);

      await page.getByRole("button", { name: "+ Add account" }).click();
      await page.getByLabel("Name").fill("Checking");
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      await page.getByRole("button", { name: "+ Add account" }).click();
      await page.getByLabel("Name").fill("Savings");
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      await page.getByRole("button", { name: "Checking" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await expect(page.getByRole("heading", { name: "Checking" })).toBeVisible();

      await page.getByRole("button", { name: "New transaction" }).click();
      await page.getByLabel("Amount").fill("42.50");
      await page.getByLabel("Payee").fill("Grocery store");
      await page.getByLabel("Category").selectOption({ label: "Groceries" });
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await expect(page.getByText("Grocery store")).toBeVisible();
      await expect(page.getByText("-€42.50").first()).toBeVisible();

      await page.getByRole("button", { name: "New transaction" }).click();
      // The radio input itself is visually hidden (`pointer-events: none`, the segmented-control
      // pattern from the mockup); a real user clicks its label, same as here.
      await page.getByRole("dialog").getByText("Transfer", { exact: true }).click();
      await page.getByLabel("Amount").fill("10.00");
      await page.getByLabel("To account").selectOption({ label: "Savings" });
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await expect(page.getByText("Transfer")).toBeVisible();

      const toggle = page.getByRole("button", { name: /change status/ }).first();
      await toggle.click();
      await expect(page.getByRole("button", { name: /Cleared: change status/ }).first()).toBeVisible();
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
