import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * Drives a real headless Chromium through the workspace switcher (#50) against the real
 * "envelope" Keycloak realm and `apps/api`, including the two Row-Level Security policies
 * (migrations 0008 and 0022) that let a user list every workspace they belong to before any one
 * of them is "current", and the last-used workspace this browser remembers across a real page
 * load (#343 — the one thing a real browser can prove that `localStorage`-in-`jsdom` cannot: an
 * actual new navigation to "/", not just a re-render). Needs `apps/api` and Keycloak already
 * running; see `e2e/README.md`.
 */
test.describe("workspace switcher (#50, #343)", () => {
  async function signIn(page: import("@playwright/test").Page, user: Awaited<ReturnType<typeof createTestUser>>) {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/realms\/envelope\/protocol\/openid-connect\/auth/);
    await page.getByLabel("Username or email").fill(user.username);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
  }

  test("shows an empty message for a user who belongs to no workspace yet", async ({ page }) => {
    const user = await createTestUser();
    try {
      await signIn(page, user);
      await expect(page.getByText("You do not belong to any workspace yet.")).toBeVisible();
    } finally {
      await user.teardown();
    }
  });

  test("skips straight to the only workspace, then offers a picker once a second one exists", async ({ page }) => {
    const user = await createTestUser();
    let first: Awaited<ReturnType<typeof createWorkspaceWithMembership>> | undefined;
    let second: Awaited<ReturnType<typeof createWorkspaceWithMembership>> | undefined;
    try {
      await signIn(page, user);
      // Not just "signed in": the user-mapper preHandler only creates this subject's local user
      // row once the app's own first authenticated request (GET /me/workspaces) completes,
      // which this message proves (a brand new user genuinely has no workspace yet).
      await expect(page.getByText("You do not belong to any workspace yet.")).toBeVisible();
      const userId = await findUserIdBySubject(user.subject);
      if (!userId) {
        throw new Error("expected a local user row for this subject after sign-in");
      }

      first = await createWorkspaceWithMembership(userId, "Famiglia");
      await page.goto("/");
      await page.waitForURL(`/${first.id}`);
      await expect(page.getByRole("button", { name: "Famiglia" })).toBeVisible();

      second = await createWorkspaceWithMembership(userId, "Personale");
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Famiglia" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Personale" })).toBeVisible();

      await page.getByRole("button", { name: "Personale" }).click();
      await page.waitForURL(`/${second.id}`);

      await page.getByRole("button", { name: "Personale" }).click(); // the switcher button, now
      await expect(page.getByRole("menuitem", { name: "Personale ✓" })).toBeVisible();
      await page.getByRole("menuitem", { name: "Famiglia" }).click();
      await page.waitForURL(`/${first.id}`);

      // #343: "/" now goes straight to the last-used workspace, skipping the picker entirely.
      await page.goto("/");
      await page.waitForURL(`/${first.id}`);
      await expect(page.getByRole("button", { name: "Famiglia" })).toBeVisible();
    } finally {
      await first?.teardown();
      await second?.teardown();
      await user.teardown();
    }
  });
});
