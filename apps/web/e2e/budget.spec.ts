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

      await expect(page.getByText("Ready to assign")).toBeVisible();
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
});
