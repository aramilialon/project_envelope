import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * Drives a real headless Chromium through the accounts screen (#51): its own "+ Add account",
 * opening an account's own register, and closing an account, against the real "envelope"
 * Keycloak realm and `apps/api`. Needs `apps/api` and Keycloak already running; see
 * `e2e/README.md`.
 */
test.describe("accounts (#51)", () => {
  async function signIn(page: import("@playwright/test").Page, user: Awaited<ReturnType<typeof createTestUser>>) {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/realms\/envelope\/protocol\/openid-connect\/auth/);
    await page.getByLabel("Username or email").fill(user.username);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
  }

  test("creates an account, opens its register, and closes it from the accounts screen", async ({ page }) => {
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

      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);

      await page.getByRole("button", { name: "+ Add account" }).click();
      await page.getByLabel("Name").fill("Checking account");
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
      await expect(page.getByRole("listitem").getByText("On budget")).toBeVisible();

      await page.getByRole("button", { name: "Checking account" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await expect(page.getByRole("heading", { name: "Checking account" })).toBeVisible();

      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);

      await page.getByRole("button", { name: "Close" }).click();
      await expect(page.getByText("Closed")).toBeVisible();
      await expect(page.getByRole("button", { name: "Close" })).not.toBeVisible();
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
