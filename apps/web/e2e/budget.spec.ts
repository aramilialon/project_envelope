import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * Drives a real headless Chromium through the budget month screen (#53): the real
 * `GET /workspaces/:workspaceId/budget-months/:month` endpoint, round-tripped for a brand new,
 * empty workspace (nothing unassigned yet, no categories yet) and across month navigation.
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

  test("shows unassigned money at zero for a brand new workspace, and navigates between months", async ({ page }) => {
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

      await page.getByRole("button", { name: /^Groceries/ }).click();
      await page.getByRole("button", { name: "Move money" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByLabel("To")).toHaveValue(/.+/);
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });

  test("the phone layout: a bottom tab bar, a category's own full-screen detail with a back link (#331)", async ({ page }) => {
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

      // The tab bar is reachable from every screen, not just the budget month.
      const tabbar = page.getByRole("navigation", { name: "Main, phone" });
      await expect(tabbar).toBeVisible();
      await expect(tabbar.getByText("Portfolio")).not.toBeAttached();

      await tabbar.getByRole("link", { name: "Budget" }).click();
      await page.waitForURL(`/${workspace.id}`);
      await page.getByText("Groceries").waitFor();

      // Tapping a category opens its own detail full screen — the list itself is gone, replaced
      // by the detail, not covered by an overlay — with a back link to return to it. The row's
      // own name *starts* with the category's (#382): a bare /Groceries/ also matches the
      // categories screen's own "Move Groceries up/down" buttons, still on screen for a moment
      // right after the tab bar's navigation.
      await page.getByRole("button", { name: /^Groceries/ }).click();
      await expect(page.getByLabel("Assigned this month")).toBeVisible();
      const back = page.getByRole("button", { name: /Budget/ });
      await expect(back).toBeVisible();
      await back.click();
      await expect(page.getByLabel("Assigned this month")).not.toBeVisible();
      await expect(page.getByText("Groceries")).toBeVisible();

      await tabbar.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });

  test("adds and renames groups and categories right from the budget month (#397)", async ({ page }) => {
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

      // A brand new workspace: a group first, then straight on to its first category.
      await page.getByRole("button", { name: "+ Add a group" }).click();
      await page.getByLabel("Name of the new group").fill("Everyday");
      await page.getByLabel("Name of the new group").press("Enter");
      const newCategory = page.getByLabel("Name of the new category in Everyday");
      await newCategory.fill("Groceries");
      await newCategory.press("Enter");
      await expect(page.getByRole("button", { name: /^Groceries/ })).toBeVisible();

      // The field stays open for the next one; a name already in the group is refused.
      await newCategory.fill("groceries");
      await newCategory.press("Enter");
      await expect(page.getByRole("alert")).toHaveText("Another category in this group already has this name.");
      await newCategory.fill("Pharmacy");
      await newCategory.press("Enter");
      await expect(page.getByRole("button", { name: /^Pharmacy/ })).toBeVisible();
      await newCategory.press("Escape");
      await expect(newCategory).not.toBeVisible();

      await page.getByRole("button", { name: "Actions for Everyday" }).click();
      await page.getByRole("menuitem", { name: "Rename group" }).click();
      await page.getByLabel("New name for the group").fill("Day to day");
      await page.getByLabel("New name for the group").press("Enter");
      await expect(page.getByRole("button", { name: "Close Day to day" })).toBeVisible();

      await page.getByRole("button", { name: /^Pharmacy/ }).click();
      await page.getByRole("button", { name: "Rename" }).click();
      await page.getByLabel("New name for the category").fill("Health");
      await page.getByLabel("New name for the category").press("Enter");
      await expect(page.getByRole("heading", { name: "Health" })).toBeVisible();

      // Reordering and archiving stay in Workspace settings, one menu item away.
      await page.getByRole("button", { name: "Actions for Day to day" }).click();
      await page.getByRole("menuitem", { name: /Reorder or archive/ }).click();
      await page.waitForURL(`/${workspace.id}/settings/categories`);
      await expect(page.locator(".categories-screen").getByText("Health", { exact: true })).toBeVisible();
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
