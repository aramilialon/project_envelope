import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * Drives a real headless Chromium through the import screen (#59): a CSV file, column mapping,
 * reviewing the staged rows, and confirming one into a real transaction. Needs `apps/api` and
 * Keycloak already running; see `e2e/README.md`.
 */
test.describe("import (#59)", () => {
  async function signIn(page: import("@playwright/test").Page, user: Awaited<ReturnType<typeof createTestUser>>) {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/realms\/[^/]+\/protocol\/openid-connect\/auth/);
    await page.getByLabel("Username or email").fill(user.username);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
  }

  test("imports a CSV statement: column mapping, review, and a real transaction", async ({ page }) => {
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
      await page.getByRole("link", { name: "Import" }).click();
      await page.waitForURL(/\/accounts\/.+\/import/);
      await expect(page.getByRole("heading", { name: "Import a bank statement" })).toBeVisible();

      const csv = "Date,Description,Amount\n2026-09-17,Grocery store,-42.50\n";
      await page.locator("#import-file-in").setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });

      await expect(page.getByText("statement.csv")).toBeVisible();
      await expect(page.getByText("Columns look good.")).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(page.getByText("Grocery store")).toBeVisible();
      await page.getByLabel("Category").selectOption({ label: "Groceries" });
      await page.getByRole("button", { name: /Import 1 transaction/ }).click();

      await expect(page.getByText("Import complete")).toBeVisible();
      await expect(page.getByText("1 transaction added as cleared.")).toBeVisible();

      await page.getByRole("button", { name: "Import another file" }).click();
      await expect(page.getByRole("heading", { name: "Import a bank statement" })).toBeVisible();
      await page.getByRole("link", { name: /Checking/ }).click();
      await page.waitForURL(/\/accounts\/[^/]+$/);
      await expect(page.getByText("Grocery store", { exact: true })).toBeVisible();
      await expect(page.getByText("-€42.50").first()).toBeVisible();
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });

  test("explains a file refused for its currency or its decimals (#671, #672)", async ({ page }) => {
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
      await page.goto(`/${workspace.id}/accounts`);
      await page.getByRole("button", { name: "+ Add account" }).click();
      await page.getByLabel("Name").fill("Checking");
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await page.getByRole("button", { name: "Checking" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await page.getByRole("link", { name: "Import" }).click();
      await page.waitForURL(/\/accounts\/.+\/import/);

      // A dollar statement into a euro account: refused at step 1, naming both currencies.
      const ofx = "<OFX><STMTRS><CURDEF>USD<STMTTRN><DTPOSTED>20260917<TRNAMT>-15.00<FITID>USD-1</STMTTRN></STMTRS></OFX>";
      await page.locator("#import-file-in").setInputFiles({ name: "dollars.ofx", mimeType: "application/x-ofx", buffer: Buffer.from(ofx) });
      await expect(page.getByRole("alert")).toHaveText(
        "A file can be imported only into an account in the same currency: this file's currency is US Dollar (USD), and this account's is Euro (EUR).",
      );

      // Three decimals in a euro amount: refused at the columns step, until the separator changes.
      const csv = "Date,Description,Amount\n2026-09-17,Fuel station,-42.505\n";
      await page.locator("#import-file-in").setInputFiles({ name: "fuel.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
      await expect(page.getByText("Columns look good.")).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("alert")).toHaveText(
        "An amount in Euro (EUR) can have at most 2 decimal places: this file has an amount with more, so it was not imported. The decimal separator chosen may not be the file's, or the file may be from an account in another currency.",
      );
      await page.getByLabel("Decimal separator").selectOption(",");
      await expect(page.getByRole("alert")).toHaveCount(0);
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
