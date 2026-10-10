import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * Drives a real headless Chromium through #61's own role gating: a `read_only` member of a real
 * workspace sees the budget month exactly as anyone else does, just with none of its write
 * actions. The Web Push opt-in itself (the other half of #61) is not covered here — headless
 * Chromium's own push stack needs a reachable push service to complete a real subscription,
 * which would make this test slow and flaky for no real product signal; `usePushSubscription`'s
 * own state machine already has solid unit coverage (`NotificationsToggle.test.tsx`) instead.
 * Needs `apps/api` and Keycloak already running; see `e2e/README.md`.
 */
test.describe("role gating (#61)", () => {
  async function signIn(page: import("@playwright/test").Page, user: Awaited<ReturnType<typeof createTestUser>>) {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/realms\/envelope\/protocol\/openid-connect\/auth/);
    await page.getByLabel("Username or email").fill(user.username);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
  }

  test("a read_only member sees the budget month with no write actions", async ({ page }) => {
    const user = await createTestUser();
    let workspace: Awaited<ReturnType<typeof createWorkspaceWithMembership>> | undefined;
    try {
      await signIn(page, user);
      await expect(page.getByText("You do not belong to any workspace yet.")).toBeVisible();
      const userId = await findUserIdBySubject(user.subject);
      if (!userId) {
        throw new Error("expected a local user row for this subject after sign-in");
      }

      workspace = await createWorkspaceWithMembership(userId, "Famiglia", "read_only");
      await page.goto("/");
      await page.waitForURL(`/${workspace.id}`);

      await expect(page.getByText("Unassigned")).toBeVisible();
      await expect(page.getByRole("button", { name: "Assign" })).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Targets" })).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Quick assign" })).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Scheduled" })).not.toBeVisible();
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
