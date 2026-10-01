import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * Drives a real headless Chromium through targets and quick assign (#55): setting a monthly
 * target on a category from the "Targets" panel, seeing it reflected there, and running
 * "Quick assign" with its default scope and mode. Needs `apps/api` and Keycloak already
 * running; see `e2e/README.md`.
 */
test.describe("targets and quick assign (#55)", () => {
  async function signIn(page: import("@playwright/test").Page, user: Awaited<ReturnType<typeof createTestUser>>) {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/realms\/envelope\/protocol\/openid-connect\/auth/);
    await page.getByLabel("Username or email").fill(user.username);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
  }

  test("sets a monthly target on a category and runs quick assign", async ({ page }) => {
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

      await page.getByRole("button", { name: "Targets" }).click();
      // Scoped to the dialog: the sidebar's own "+ Add account" button also matches "+ Add"
      // under Playwright's default substring name matching.
      await page.getByRole("dialog", { name: "Targets" }).getByRole("button", { name: "+ Add", exact: true }).click();
      await page.getByLabel("Amount", { exact: true }).fill("60.00");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("heading", { name: "Targets" })).toBeVisible();
      await expect(page.getByText("Monthly amount")).toBeVisible();
      await expect(page.getByText(/Asks €60.00/)).toBeVisible();
      await page.getByRole("button", { name: "× Close" }).click();

      await page.getByRole("button", { name: "Quick assign" }).click();
      await page.getByRole("button", { name: "Run" }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
