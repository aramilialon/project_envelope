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
      // Exact, the row's own open button: "Grocery store" also now appears in the timeline's own
      // label and the "To do" list's own "Mark Grocery store" item (#337).
      await expect(page.getByRole("button", { name: "Grocery store", exact: true })).toBeVisible();
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

  test("the register's own 'To do' list: Record an overdue scheduled transaction, Mark a pending one cleared, and the timeline folds away while a side sheet is open (#337)", async ({ page }) => {
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
      await page.getByLabel("Category name").fill("Internet and phone");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByText("Internet and phone")).toBeVisible();

      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await page.getByRole("button", { name: "+ Add account" }).click();
      await page.getByLabel("Name").fill("Checking");
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      // A scheduled transaction due yesterday — overdue the moment it is saved, no need to wait.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await page.getByRole("link", { name: "Budget" }).click();
      await page.waitForURL(`/${workspace.id}`);
      await page.getByRole("button", { name: "Scheduled", exact: true }).click();
      await page.getByRole("button", { name: "+ New scheduled transaction" }).click();
      await page.getByLabel("Payee").fill("Internet provider");
      // { exact: true }: "Use it as this category's target" also matches "Category" otherwise.
      await page.getByLabel("Category", { exact: true }).selectOption({ label: "Everyday · Internet and phone" });
      await page.getByLabel("Account").selectOption({ label: "Checking" });
      await page.getByLabel("Amount").fill("45.00");
      await page.getByLabel("Next date").fill(yesterday);
      await page.getByRole("button", { name: "Save" }).click();
      // The "Scheduled" panel itself stays open after saving (only its own form collapses) —
      // unlike "New transaction"'s own dialog, which closes on submit.
      await expect(page.getByRole("button", { name: "+ New scheduled transaction" })).toBeVisible();
      await page.getByRole("button", { name: "× Close" }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await page.getByRole("button", { name: "Checking" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await expect(page.getByRole("heading", { name: "Checking" })).toBeVisible();

      // A pending transaction of its own, for "Mark".
      await page.getByRole("button", { name: "New transaction" }).click();
      await page.getByLabel("Amount").fill("9.99");
      await page.getByLabel("Payee").fill("Streaming service");
      await page.getByLabel("Category").selectOption({ label: "Internet and phone" });
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      await expect(page.getByText("Record Internet provider")).toBeVisible();
      await expect(page.getByText("Mark Streaming service")).toBeVisible();
      await expect(page.locator(".time")).toBeVisible();

      // The timeline and "To do" list fold away entirely while a side sheet is open.
      await page.getByRole("button", { name: "New transaction" }).click();
      await expect(page.locator(".time")).not.toBeVisible();
      await expect(page.getByText("Record Internet provider")).not.toBeVisible();
      await page.getByRole("button", { name: "× Close" }).click();

      await page.getByRole("button", { name: /Record Internet provider/ }).click();
      await expect(page.getByText("Record Internet provider")).not.toBeVisible();
      await expect(page.getByText("Internet provider").first()).toBeVisible();

      await page.getByRole("button", { name: /Mark Streaming service/ }).click();
      await expect(page.getByText("Mark Streaming service")).not.toBeVisible();
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
