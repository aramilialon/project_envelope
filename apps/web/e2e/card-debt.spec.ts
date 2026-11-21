import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * Card debt is asked once, on the card's payment category (#728): a category overspent €50 in
 * cash and €300 with a card asks "To do" for its €50 only, the card asks for the €300, and the
 * category's detail says where its card part went, with a link that opens the card's payment
 * category. Needs `apps/api` and Keycloak already running; see `e2e/README.md`.
 */
test.describe("card debt asked once (#728)", () => {
  async function signIn(page: import("@playwright/test").Page, user: Awaited<ReturnType<typeof createTestUser>>) {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/realms\/[^/]+\/protocol\/openid-connect\/auth/);
    await page.getByLabel("Username or email").fill(user.username);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
  }

  async function addAccount(page: import("@playwright/test").Page, name: string, typeLabel?: string) {
    await page.getByRole("button", { name: "+ Add account" }).click();
    const dialog = page.getByRole("dialog");
    await page.getByLabel("Name").fill(name);
    if (typeLabel) {
      await dialog.getByText(typeLabel, { exact: true }).click();
    }
    await dialog.getByRole("button", { name: "Add account", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }

  async function addTransaction(
    page: import("@playwright/test").Page,
    workspaceId: string,
    account: string,
    transaction: { readonly amount: string; readonly payee: string; readonly category?: string; readonly inflow?: boolean },
  ) {
    await page.getByRole("link", { name: "Accounts" }).click();
    await page.waitForURL(`/${workspaceId}/accounts`);
    await page.getByRole("button", { name: account, exact: true }).click();
    await page.waitForURL(/\/accounts\/.+/);
    await page.getByRole("button", { name: "New transaction" }).click();
    if (transaction.inflow) {
      await page.getByRole("dialog").getByText("Inflow", { exact: true }).click();
    }
    await page.getByLabel("Amount").fill(transaction.amount);
    await page.getByLabel("Payee").fill(transaction.payee);
    if (transaction.category) {
      await page.getByLabel("Category").selectOption({ label: transaction.category });
    }
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }

  test("a category overspent in cash and with a card: each part asked once, the card part on the card", async ({ page }) => {
    test.setTimeout(90_000);
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

      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await addAccount(page, "Checking");
      await addAccount(page, "Visa", "Credit card");

      // V2: nothing assigned to Groceries, €50 spent from checking and €300 on the card.
      await addTransaction(page, workspace.id, "Checking", { amount: "1000.00", payee: "Salary", inflow: true });
      await addTransaction(page, workspace.id, "Checking", { amount: "50.00", payee: "Market", category: "Groceries" });
      await addTransaction(page, workspace.id, "Visa", { amount: "300.00", payee: "Supermarket", category: "Groceries" });

      await page.getByRole("link", { name: "Budget" }).click();
      await page.waitForURL(`/${workspace.id}`);
      await expect(page.getByText("€50.00 overspent in cash, €300.00 with a card")).toBeVisible();

      // To do: €50.00 on Groceries, €300.00 on the card — €350.00 in all, never €650.00.
      const todo = page.locator(".todo");
      await expect(todo.getByRole("button", { name: /^Cover Groceries/ })).toContainText("€50.00");
      await expect(todo.getByRole("button", { name: /^Debt to cover: Visa payment/ })).toContainText("€300.00");

      // The category's detail says where the card part went, and opens the card's payment category.
      await page.locator(".bars").getByRole("button", { name: /^Groceries/ }).click();
      await expect(page.getByText("€300.00 spent with a card beyond what was available is now part of the card's debt, in Visa payment.")).toBeVisible();
      await page.getByRole("button", { name: "Open Visa payment" }).click();
      await expect(page.getByRole("button", { name: "Assign €300.00 from unassigned money" })).toBeVisible();
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
