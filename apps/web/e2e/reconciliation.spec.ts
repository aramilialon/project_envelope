import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * Drives a real headless Chromium through the reconciliation screen (#60): a cleared transaction,
 * a matching statement balance, locking it, and unlocking it again. Needs `apps/api` and Keycloak
 * already running; see `e2e/README.md`.
 */
test.describe("reconciliation (#60)", () => {
  async function signIn(page: import("@playwright/test").Page, user: Awaited<ReturnType<typeof createTestUser>>) {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/realms\/[^/]+\/protocol\/openid-connect\/auth/);
    await page.getByLabel("Username or email").fill(user.username);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
  }

  test("reconciles a cleared transaction to a matching statement balance, then unlocks it", async ({ page }) => {
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
      await page.getByLabel("Name").fill("Checking");
      await page.getByRole("button", { name: "Add account", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      await page.getByRole("button", { name: "Checking" }).click();
      await page.waitForURL(/\/accounts\/.+/);
      await expect(page.getByRole("heading", { name: "Checking" })).toBeVisible();

      await page.getByRole("button", { name: "New transaction" }).click();
      await page.getByRole("dialog").getByText("Inflow", { exact: true }).click();
      await page.getByLabel("Amount").fill("500.00");
      await page.getByLabel("Payee").fill("Salary");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      // Pending -> cleared, so there is something to reconcile.
      await page.getByRole("button", { name: /change status/ }).first().click();
      await expect(page.getByRole("button", { name: /Cleared: change status/ }).first()).toBeVisible();

      await page.getByRole("link", { name: "Reconcile" }).click();
      await page.waitForURL(/\/accounts\/.+\/reconcile/);
      await expect(page.getByRole("heading", { name: "Reconcile with your bank" })).toBeVisible();
      await expect(page.getByText("€500.00").first()).toBeVisible();

      // Both statement fields stay inside the tally panel, at desktop and phone widths (#592).
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        const panel = await page.getByRole("complementary", { name: "Tally" }).boundingBox();
        if (!panel) {
          throw new Error("expected the tally panel to be laid out");
        }
        for (const label of ["Statement balance", "As of"]) {
          const field = await page.getByLabel(label).boundingBox();
          if (!field) {
            throw new Error(`expected the "${label}" field to be laid out`);
          }
          expect(field.x, `${label} at ${viewport.width}px`).toBeGreaterThanOrEqual(panel.x);
          expect(field.x + field.width, `${label} at ${viewport.width}px`).toBeLessThanOrEqual(panel.x + panel.width);
        }
      }
      await page.setViewportSize({ width: 1280, height: 720 });

      await page.getByLabel("Statement balance").fill("500.00");
      await expect(page.getByText("Everything matches.")).toBeVisible();
      await page.getByRole("button", { name: "Lock 1 transaction" }).click();
      await expect(page.getByText("Reconciliation complete")).toBeVisible();

      await page.getByRole("link", { name: "Back to the account" }).click();
      await page.waitForURL(/\/accounts\/[^/]+$/);
      await expect(page.getByRole("button", { name: "Reconciled", exact: true })).toBeVisible();

      // Unlocking puts it back to "cleared".
      await page.getByRole("button", { name: "Salary" }).click();
      await expect(page.getByText(/reconciled and locked/)).toBeVisible();
      await page.getByRole("button", { name: "Unlock" }).click();
      await expect(page.getByText(/reconciled and locked/)).not.toBeVisible();
      await expect(page.getByRole("button", { name: /Cleared: change status/ }).first()).toBeVisible();
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
