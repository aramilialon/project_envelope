import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * The milestone's own "done when" criterion (0.1.7 Web MVP: "a month of budgeting is possible
 * from the browser"): one continuous journey through a real headless Chromium, touching every
 * screen the milestone built rather than one screen in isolation — categories and accounts
 * (#51, #52), the budget month and its band (#53, #58, #217), transactions and a transfer to an
 * off-budget account with its own required category (#54, #378), assigning and moving money,
 * including a card's own payment category (#55, #56, #57), import and reconciliation (#59, #60),
 * and the instant unresolved-problem toast (#61). Each of these already has its own focused spec
 * for its edge cases; this one only proves they fit together
 * into a single month end to end. Needs `apps/api` and Keycloak already running; see
 * `e2e/README.md`.
 */
test.describe("a full budget month (#63)", () => {
  async function signIn(page: import("@playwright/test").Page, user: Awaited<ReturnType<typeof createTestUser>>) {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/realms\/envelope\/protocol\/openid-connect\/auth/);
    await page.getByLabel("Username or email").fill(user.username);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
  }

  async function addAccount(
    page: import("@playwright/test").Page,
    name: string,
    typeLabel?: string,
    options?: { readonly owed?: string; readonly onBudget?: boolean },
  ) {
    await page.getByRole("button", { name: "+ Add account" }).click();
    const dialog = page.getByRole("dialog");
    await page.getByLabel("Name").fill(name);
    if (typeLabel) {
      // The type radio's own input is visually hidden (the segmented-control pattern); a real
      // user clicks its label, same as the transaction-type picker in transactions.spec.ts.
      await dialog.getByText(typeLabel, { exact: true }).click();
    }
    if (options?.onBudget === false) {
      await dialog.getByLabel("On budget").uncheck();
    }
    if (options?.owed !== undefined) {
      await page.getByLabel("How much do you currently owe on this card?").fill(options.owed);
    }
    await dialog.getByRole("button", { name: "Add account", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }

  async function assign(page: import("@playwright/test").Page, toLabel: string, amount: string) {
    await page.getByRole("button", { name: "Assign", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("To").selectOption({ label: toLabel });
    await dialog.getByLabel("Amount", { exact: true }).fill(amount);
    await dialog.getByRole("button", { name: `Assign €${amount}`, exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }

  test("a full month: accounts, categories, assigning, transactions, targets, scheduled, import, reconciliation, and the instant toast", async ({ page }) => {
    test.setTimeout(120_000);
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

      // Categories (#52): one group, two categories.
      await page.getByRole("button", { name: "Famiglia" }).click();
      await page.getByRole("menuitem", { name: "Workspace settings" }).click();
      await page.waitForURL(`/${workspace.id}/settings/categories`);
      await page.getByRole("button", { name: "+ Add a group" }).click();
      await page.getByLabel("Group name").fill("Everyday");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("button", { name: "+ Add a category" }).click();
      await page.getByLabel("Category name").fill("Groceries");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("button", { name: "+ Add a category" }).click();
      await page.getByLabel("Category name").fill("Internet and phone");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByText("Internet and phone")).toBeVisible();

      // Accounts (#51): a checking account, a credit card with an opening debt (#57's own
      // payment category comes from this), and a savings account for the transfer and the
      // reconciliation below.
      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await addAccount(page, "Checking");
      await addAccount(page, "Credit card", "Credit card", { owed: "100.00" });
      // Off-budget (a brokerage, design.md's own example): the transfer below needs a category
      // on its on-budget leg (#378), the account itself is outside the budget entirely.
      await addAccount(page, "Savings", "Savings", { onBudget: false });

      // Income lands as unassigned money, not a category (#53's own "ready to assign").
      await page.getByRole("button", { name: "Checking" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await page.getByRole("button", { name: "New transaction" }).click();
      await page.getByRole("dialog").getByText("Inflow", { exact: true }).click();
      await page.getByLabel("Amount").fill("600.00");
      await page.getByLabel("Payee").fill("Salary");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      // Budget month (#53): the new income is unassigned, and the card's payment category
      // already carries the opening debt, uncovered until money is set aside for it.
      await page.getByRole("link", { name: "Budget" }).click();
      await page.waitForURL(`/${workspace.id}`);
      await expect(page.locator(".rta .amt")).toHaveText("€600.00");
      await page.getByRole("button", { name: /^Credit card payment /  }).click();
      // The card has a starting balance (#355): the specific sentence, not the generic fallback.
      await expect(page.getByText(/already there when you added the card/)).toBeVisible();

      // Assigning (#55/#56), including the payment category's own dedicated action (#57): the
      // card's debt becomes fully covered, and the two spending categories get their budgets.
      await page.getByRole("button", { name: /Assign €100\.00 from unassigned money/ }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Amount", { exact: true }).fill("100.00");
      await dialog.getByRole("button", { name: "Assign €100.00", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      // The row detail itself stays open across the refetch that follows (only its own side
      // sheet closed) — no need to reopen it to see the updated, now-covered state.
      await expect(page.getByText("The card's debt is fully covered by money set aside.")).toBeVisible();
      await page.getByRole("button", { name: "× Close" }).click();

      await assign(page, "Groceries (€0.00)", "350.00");
      await assign(page, "Internet and phone (€0.00)", "150.00");
      await expect(page.locator(".rta .amt")).toHaveText("€0.00");

      // Transactions and a transfer (#54): a plain outflow, and money moving to the savings
      // account.
      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await page.getByRole("button", { name: "Checking" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await page.getByRole("button", { name: "New transaction" }).click();
      await page.getByLabel("Amount").fill("42.50");
      await page.getByLabel("Payee").fill("Grocery store");
      await page.getByLabel("Category").selectOption({ label: "Groceries" });
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Grocery store", exact: true })).toBeVisible();

      // A transfer to the off-budget Savings account: money leaving the budget needs a category,
      // the same as ordinary spending (#378).
      await page.getByRole("button", { name: "New transaction" }).click();
      await page.getByRole("dialog").getByText("Transfer", { exact: true }).click();
      await page.getByLabel("Amount").fill("50.00");
      await page.getByLabel("To account").selectOption({ label: "Savings" });
      await page.getByLabel("Category").selectOption({ label: "Groceries" });
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      // A credit card charge (#57): spending a category's own money through the card moves it
      // into the payment category instead of leaving it uncovered.
      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await page.getByRole("button", { name: "Credit card" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await page.getByRole("button", { name: "New transaction" }).click();
      await page.getByLabel("Amount").fill("30.00");
      await page.getByLabel("Payee").fill("Online shop");
      await page.getByLabel("Category").selectOption({ label: "Internet and phone" });
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      await page.getByRole("link", { name: "Budget" }).click();
      await page.waitForURL(`/${workspace.id}`);
      await page.getByRole("button", { name: /^Credit card payment /  }).click();
      await expect(page.getByText("The card's debt is fully covered by money set aside.")).toBeVisible();
      await page.getByRole("button", { name: "× Close" }).click();

      // Reconciliation (#60), on the savings account: the incoming transfer, cleared, matching a
      // statement balance.
      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await page.getByRole("button", { name: "Savings" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await page.getByRole("button", { name: /Pending: change status/ }).first().click();
      await expect(page.getByRole("button", { name: /Cleared: change status/ })).toBeVisible();

      await page.getByRole("button", { name: /Reconcile the account/ }).click();
      await page.waitForURL(/\/accounts\/.+\/reconcile/);
      await page.getByLabel("Statement balance").fill("50.00");
      await expect(page.getByText("Everything matches.")).toBeVisible();
      await page.getByRole("button", { name: /Lock 1 transaction/ }).click();
      await expect(page.getByText("Reconciliation complete")).toBeVisible();

      // Targets and quick assign (#55).
      await page.getByRole("link", { name: "Budget" }).click();
      await page.waitForURL(`/${workspace.id}`);
      await page.getByRole("button", { name: "Targets" }).click();
      await page
        .getByRole("dialog", { name: "Targets" })
        .getByRole("listitem")
        .filter({ hasText: "Internet and phone" })
        .getByRole("button", { name: "+ Add", exact: true })
        .click();
      await page.getByLabel("Amount", { exact: true }).fill("50.00");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText(/Asks €50.00/)).toBeVisible();
      await page.getByRole("button", { name: "× Close" }).click();

      await page.getByRole("button", { name: "Quick assign" }).click();
      await page.getByRole("button", { name: "Run" }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      // A scheduled transaction (#217), overdue the moment it is saved.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await page.getByRole("button", { name: "Scheduled", exact: true }).click();
      await page.getByRole("button", { name: "+ New scheduled transaction" }).click();
      await page.getByLabel("Payee").fill("Gym membership");
      await page.getByLabel("Category", { exact: true }).selectOption({ label: "Everyday · Groceries" });
      await page.getByLabel("Account").selectOption({ label: "Checking" });
      await page.getByLabel("Amount").fill("15.00");
      await page.getByLabel("Next date").fill(yesterday);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("button", { name: "+ New scheduled transaction" })).toBeVisible();
      await page.getByRole("button", { name: "× Close" }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      // The instant unresolved-problem toast (#61): moving money back to unassigned, without
      // leaving the budget month, makes it "newly arrived" right away, no refresh needed.
      await page.getByRole("button", { name: "Assign", exact: true }).click();
      const fromSelect = page.getByLabel("From");
      const groceriesValue = await fromSelect.locator("option", { hasText: "Groceries" }).getAttribute("value");
      await fromSelect.selectOption(groceriesValue ?? "");
      await page.getByLabel("To").selectOption("unassigned");
      await page.getByLabel("Amount", { exact: true }).fill("20.00");
      await page.getByRole("button", { name: /Move €20\.00/ }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await expect(page.getByRole("status").getByText("€20.00 arrived and is still unassigned.")).toBeVisible();
      await page.getByRole("button", { name: "Close this message" }).click();
      await expect(page.getByText("€20.00 arrived and is still unassigned.")).not.toBeVisible();

      // Recording the overdue scheduled transaction from the account register's own "To do"
      // list (#337, reached from #54's own screen).
      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await page.getByRole("button", { name: "Checking" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await expect(page.getByText("Record Gym membership")).toBeVisible();
      await page.getByRole("button", { name: /Record Gym membership/ }).click();
      await expect(page.getByText("Record Gym membership")).not.toBeVisible();
      await expect(page.getByText("Gym membership").first()).toBeVisible();

      // Import (#59): a statement with one new transaction, categorized and confirmed.
      await page.getByRole("link", { name: "Import" }).click();
      await page.waitForURL(/\/accounts\/.+\/import/);
      const csv = "Date,Description,Amount\n2026-09-17,Pharmacy,-12.00\n";
      await page.locator("#import-file-in").setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
      await expect(page.getByText("Columns look good.")).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByText("Pharmacy")).toBeVisible();
      await page.getByLabel("Category").selectOption({ label: "Groceries" });
      await page.getByRole("button", { name: /Import 1 transaction/ }).click();
      await expect(page.getByText("Import complete")).toBeVisible();

      // Days of buffer (#58) and month navigation (#53), the band's own last pieces.
      await page.getByRole("link", { name: "Budget" }).click();
      await page.waitForURL(`/${workspace.id}`);
      await expect(page.getByText("Days of buffer")).toBeVisible();

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
