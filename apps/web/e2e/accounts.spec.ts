import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject, listTaxRegimes, setWorkspaceTaxCountry } from "./db.ts";
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
    await page.waitForURL(/\/realms\/[^/]+\/protocol\/openid-connect\/auth/);
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

  test("creates a brokerage account with its tax regime in an IT workspace (#508)", async ({ page }) => {
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
      await setWorkspaceTaxCountry(workspace.id, "IT");
      await page.goto("/");
      await page.waitForURL(`/${workspace.id}`);

      await page.getByRole("link", { name: "Accounts", exact: true }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);

      await page.getByRole("button", { name: "+ Add account" }).click();
      await page.getByLabel("Name").fill("Broker");
      await page.getByRole("radio", { name: /Brokerage/ }).check();
      await expect(page.getByRole("button", { name: "Add account", exact: true })).toBeDisabled();
      await page.getByRole("group", { name: "Tax regime" }).getByRole("radio", { name: "Administered" }).check();
      // An administered account's broker is always an Italian withholding agent: no question asked.
      await expect(page.getByRole("checkbox", { name: /withholding agent/ })).not.toBeVisible();
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      await expect(page.getByRole("button", { name: "Broker" })).toBeVisible();
      expect(await listTaxRegimes("Broker", workspace.id)).toEqual([{ regime: "administered" }]);
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });

  test("opens the accounts panel from the band, switching registers without closing it (#412)", async ({ page }) => {
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

      await page.getByRole("link", { name: "Accounts", exact: true }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      for (const name of ["Checking account", "Savings account"]) {
        await page.getByRole("button", { name: "+ Add account" }).click();
        await page.getByLabel("Name").fill(name);
        await page.getByRole("button", { name: "Add account", exact: true }).click();
        await expect(page.getByRole("dialog")).not.toBeVisible();
      }

      // Closed by default, from any screen — here the budget month.
      await page.getByRole("link", { name: "Budget", exact: true }).click();
      await page.waitForURL(`/${workspace.id}`);
      const panel = page.getByRole("complementary", { name: "Accounts" });
      await expect(panel).not.toBeAttached();
      await page.getByRole("button", { name: "Show accounts" }).click();
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("heading", { name: "Net worth" })).toBeVisible();
      await expect(panel.getByText("€0.00").first()).toBeVisible();

      // A row switches the main content to that account's register; the panel stays open.
      await panel.getByRole("button", { name: /^Savings account/ }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await expect(page.getByRole("heading", { name: "Savings account" })).toBeVisible();
      await expect(panel.getByRole("button", { name: /^Savings account/ })).toHaveAttribute("aria-current", "true");
      await panel.getByRole("button", { name: /^Checking account/ }).click();
      await expect(page.getByRole("heading", { name: "Checking account" })).toBeVisible();

      await panel.getByRole("link", { name: "Go to the Accounts screen →" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);

      await page.keyboard.press("Escape");
      await expect(panel).not.toBeAttached();
      await expect(page.getByRole("button", { name: "Show accounts" })).toHaveAttribute("aria-pressed", "false");
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
