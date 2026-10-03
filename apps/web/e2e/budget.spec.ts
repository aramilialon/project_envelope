import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * Drives a real headless Chromium through the budget month screen (#53): the real
 * `GET /workspaces/:workspaceId/budget-months/:month` endpoint, round-tripped for a brand new,
 * empty workspace (ready to assign at zero, no categories yet) and across month navigation.
 * Needs `apps/api` and Keycloak already running; see `e2e/README.md`.
 */
test.describe("budget month (#53)", () => {
  async function signIn(page: import("@playwright/test").Page, user: Awaited<ReturnType<typeof createTestUser>>) {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/realms\/envelope\/protocol\/openid-connect\/auth/);
    await page.getByLabel("Username or email").fill(user.username);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
  }

  test("shows ready to assign at zero for a brand new workspace, and navigates between months", async ({ page }) => {
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

      await expect(page.getByText("Unassigned")).toBeVisible();
      await expect(page.getByText("No categories yet: add some from Workspace settings.")).toBeVisible();

      const monthHeading = page.getByRole("heading", { level: 1 });
      const initialMonth = await monthHeading.textContent();
      await page.getByRole("button", { name: "Next month" }).click();
      await expect(monthHeading).not.toHaveText(initialMonth ?? "");
      await page.getByRole("button", { name: "Previous month" }).click();
      await expect(monthHeading).toHaveText(initialMonth ?? "");
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });

  test("assigns unassigned money to a category from the band's 'Assign' button (#328)", async ({ page }) => {
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

      await page.getByRole("link", { name: "Budget" }).click();
      await page.waitForURL(`/${workspace.id}`);
      await page.getByText("Groceries").waitFor();

      await page.getByRole("button", { name: "Assign", exact: true }).click();
      await page.getByLabel("To").selectOption({ label: "Groceries (€0.00)" });
      await page.getByLabel("Amount", { exact: true }).fill("10.00");
      await page.getByRole("button", { name: /Assign €10\.00/ }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      await expect(page.getByText("€10.00 to spend")).toBeVisible();

      await page.getByRole("button", { name: /Groceries/ }).click();
      await page.getByRole("button", { name: "Move money" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByLabel("To")).toHaveValue(/.+/);
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
