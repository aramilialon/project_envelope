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
    await page.waitForURL(/\/realms\/[^/]+\/protocol\/openid-connect\/auth/);
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

  test("on a closed account's register, reached by its address, a refused status change says the account is closed (#741)", async ({ page }) => {
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
      await page.getByRole("button", { name: "+ Add account" }).click();
      await page.getByLabel("Name").fill("Checking");
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      // An outflow and an inflow of the same amount, both pending, leave a balance of zero, so
      // the account can be closed with transactions still on it.
      await page.getByRole("button", { name: "Checking" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      const registerUrl = page.url();
      await page.getByRole("button", { name: "New transaction" }).click();
      await page.getByLabel("Amount").fill("10.00");
      await page.getByLabel("Payee").fill("Grocery store");
      await page.getByLabel("Category").selectOption({ label: "Groceries" });
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await page.getByRole("button", { name: "New transaction" }).click();
      await page.getByRole("dialog").getByText("Inflow", { exact: true }).click();
      await page.getByLabel("Amount").fill("10.00");
      await page.getByLabel("Payee").fill("Refund");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await page.getByRole("button", { name: "Close" }).click();
      await expect(page.getByText("Closed")).toBeVisible();

      await page.goto(registerUrl);
      await expect(page.getByRole("heading", { name: "Checking" })).toBeVisible();
      await page.getByRole("button", { name: "Pending: change status" }).first().click();
      await expect(page.getByRole("alert")).toHaveText("This account is closed, so its transactions can't be changed.");
      await expect(page.getByRole("button", { name: "Pending: change status" })).toHaveCount(2);
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
      await page.getByLabel("Account", { exact: true }).selectOption({ label: "Checking" });
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

  test("deletes an existing transaction (#403)", async ({ page }) => {
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
      await page.getByRole("button", { name: "+ Add account" }).click();
      await page.getByLabel("Name").fill("Checking");
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      await page.getByRole("button", { name: "Checking" }).click();
      await page.waitForURL(/\/accounts\/.+/);

      await page.getByRole("button", { name: "New transaction" }).click();
      await page.getByLabel("Amount").fill("42.50");
      await page.getByLabel("Payee").fill("Grocery store");
      await page.getByLabel("Category").selectOption({ label: "Groceries" });
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Grocery store", exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Grocery store", exact: true }).click();
      await page.getByRole("button", { name: "Delete" }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      // Both the row and its own "Mark Grocery store" to-do item stay on the page until the
      // register's refetch lands (#494): a count of zero is retried until then, and proves both
      // are gone — `not.toBeVisible()` would fail outright on strict mode while two still match.
      await expect(page.getByText("Grocery store")).toHaveCount(0);
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });

  test("a row dated after today waits under 'Later', not in today's balance and not awaiting the bank (#702)", async ({ page }) => {
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
      await page.getByLabel("Category name").fill("Insurance");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByText("Insurance")).toBeVisible();

      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await page.getByRole("button", { name: "+ Add account" }).click();
      await page.getByLabel("Name").fill("Checking");
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await page.getByRole("button", { name: "Checking" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await expect(page.getByRole("heading", { name: "Checking" })).toBeVisible();

      // One row today (the form's default date), one on 15 January next year.
      await page.getByRole("button", { name: "New transaction" }).click();
      await page.getByLabel("Amount").fill("10.00");
      await page.getByLabel("Payee").fill("Bakery");
      await page.getByLabel("Category").selectOption({ label: "Insurance" });
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      // Next year in the workspace's own time zone (Europe/Rome, db.ts), not UTC's or the browser's:
      // around New Year they can disagree, and the row must land after today either way.
      const nextYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric" }).format(new Date())) + 1;
      await page.getByRole("button", { name: "New transaction" }).click();
      await page.getByLabel("Date").fill(`${nextYear}-01-15`);
      await page.getByLabel("Amount").fill("30.00");
      await page.getByLabel("Payee").fill("Home insurer");
      await page.getByLabel("Category").selectOption({ label: "Insurance" });
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      // Today's balance leaves the later row out; the row shows the balance it leads to.
      const balances = page.getByLabel("Account balances");
      await expect(balances).toContainText(/^Balance\s*-€10\.00/);
      await expect(balances).toContainText("Pending -€10.00");
      // The later row is next year, past the month end: not even in the projected balance.
      await expect(balances).toContainText("Projected at month end -€10.00");
      await expect(balances).not.toContainText("40.00");
      const later = page.getByRole("rowgroup").filter({ has: page.getByRole("rowheader", { name: "Later Dated after today: not in today's balance." }) });
      const laterRow = later.getByRole("row").filter({ hasText: "Home insurer" });
      await expect(laterRow).toContainText(`Jan 15, ${nextYear}`);
      await expect(laterRow).toContainText("-40.00");
      await expect(later.getByText("Bakery")).toHaveCount(0);
      // Pending, but it has not happened yet: only today's row awaits the bank.
      await expect(page.getByText("Mark Bakery")).toBeVisible();
      await expect(page.getByText("Mark Home insurer")).toHaveCount(0);

      // The Accounts screen shows the same balance as of today.
      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      const checking = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Checking", exact: true }) });
      await expect(checking).toContainText("-€10.00");
      await expect(checking).not.toContainText("40.00");
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });

  test("money coming in from an off-budget account lands as Unassigned by default, and can be moved to a category (#599)", async ({ page }) => {
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

      // An on-budget checking account, and a brokerage account, off budget.
      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await page.getByRole("button", { name: "+ Add account" }).click();
      await page.getByLabel("Name").fill("Checking");
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await page.getByRole("button", { name: "+ Add account" }).click();
      await page.getByLabel("Name").fill("Broker");
      await page.getByRole("radio", { name: /Brokerage/ }).check();
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      await page.getByRole("button", { name: "Checking" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await expect(page.getByRole("heading", { name: "Checking" })).toBeVisible();

      // From the broker: "Unassigned" is offered first and already chosen, with what it holds.
      await page.getByRole("button", { name: "New transaction" }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByText("Transfer", { exact: true }).click();
      await sheet.getByText("From another account", { exact: true }).click();
      await sheet.getByLabel("Amount").fill("5000.00");
      await sheet.getByLabel("From account").selectOption({ label: "Broker (off budget)" });
      const category = sheet.getByLabel("Category");
      await expect(category.locator("option").first()).toHaveText("Unassigned (€0.00)");
      await expect(category).toHaveValue("");
      await expect(sheet.getByText("The money comes into the budget: “Unassigned” goes from €0.00 to €5,000.00.")).toBeVisible();
      await sheet.getByRole("button", { name: "Add", exact: true }).click();
      await expect(sheet).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Transfer · From Broker · Unassigned" })).toBeVisible();

      // The money is there to assign in the budget month: the band's own "Unassigned" figure, not
      // just any €5,000.00 on the page (the timeline's labels show it too).
      await page.getByRole("link", { name: "Budget" }).click();
      await page.waitForURL(`/${workspace.id}`);
      await expect(page.locator(".rta .amt")).toHaveText("€5,000.00");

      // Edited afterwards, the same money goes into Groceries instead.
      await page.getByRole("link", { name: "Accounts" }).click();
      await page.waitForURL(`/${workspace.id}/accounts`);
      await page.getByRole("button", { name: "Checking" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await page.getByRole("button", { name: "Transfer · From Broker · Unassigned" }).click();
      await sheet.getByLabel("Category").selectOption({ label: "Groceries" });
      await expect(sheet.getByText("The money comes into the budget: Groceries goes from €0.00 to €5,000.00.")).toBeVisible();
      await sheet.getByRole("button", { name: "Save" }).click();
      await expect(sheet).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Transfer · From Broker · Groceries" })).toBeVisible();

      // Going out to the broker, a category is still required.
      await page.getByRole("button", { name: "New transaction" }).click();
      await sheet.getByText("Transfer", { exact: true }).click();
      await sheet.getByLabel("Amount").fill("100.00");
      await sheet.getByLabel("To account").selectOption({ label: "Broker (off budget)" });
      await expect(sheet.getByLabel("Category").locator("option").first()).toHaveText("Choose a category");
      await sheet.getByRole("button", { name: "Add", exact: true }).click();
      await expect(sheet.getByRole("alert")).toHaveText("Choose a category.");
      await sheet.getByRole("button", { name: "Cancel" }).click();
      await expect(sheet).not.toBeVisible();

      // On a phone the form is full screen, above the tab bar: its buttons are never underneath it.
      // Playwright's click refuses an element another one covers, so the click itself proves it.
      await page.setViewportSize({ width: 360, height: 780 });
      await page.reload();
      await expect(page.getByRole("navigation", { name: "Main, phone" })).toBeVisible();
      await page.getByRole("button", { name: "New transaction" }).click();
      await sheet.getByText("Transfer", { exact: true }).click();
      await sheet.getByText("From another account", { exact: true }).click();
      await sheet.getByLabel("Amount").fill("20.00");
      await sheet.getByLabel("From account").selectOption({ label: "Broker (off budget)" });
      await sheet.getByRole("button", { name: "Add", exact: true }).click({ timeout: 5_000 });
      await expect(sheet).not.toBeVisible();
      await page.setViewportSize({ width: 1280, height: 720 });
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
