import { expect, test } from "@playwright/test";

import { createWorkspaceWithMembership, findUserIdBySubject } from "./db.ts";
import { createTestUser } from "./keycloak-test-user.ts";

/**
 * Drives a real headless Chromium through sign-in (#49) against the real "envelope" Keycloak
 * realm — the one thing #49's own committed suite could not cover (its unit tests mock
 * `react-oidc-context`'s `useAuth` entirely). Needs `apps/api` and Keycloak already running
 * (`infra/docker-compose.yml`); see `e2e/README.md`.
 *
 * Reaching a real "signed-in" screen with a sign-out button needs a workspace (#50: landing on
 * "/" with none shows the workspace gate, not `Home`), so this creates one through `db.ts` —
 * sign-in's own test naturally grew to depend on #50's fixture helper once that screen existed.
 */
test.describe("sign-in (#49)", () => {
  test("signs in through Keycloak and reaches the authenticated screen", async ({ page }) => {
    const user = await createTestUser();
    let workspace: Awaited<ReturnType<typeof createWorkspaceWithMembership>> | undefined;
    try {
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      await page.getByRole("button", { name: "Sign in" }).click();

      // Keycloak's own login form, not this app's.
      await page.waitForURL(/\/realms\/envelope\/protocol\/openid-connect\/auth/);
      await page.getByLabel("Username or email").fill(user.username);
      await page.getByLabel("Password", { exact: true }).fill(user.password);
      await page.getByRole("button", { name: "Sign In" }).click();
      await page.waitForURL("/");

      // Not just a URL check: the user-mapper preHandler only creates this subject's local
      // user row once the app's own first authenticated request (GET /me/workspaces) actually
      // completes, which this message proves (a brand new user genuinely has none yet).
      await expect(page.getByText("You do not belong to any workspace yet.")).toBeVisible();
      const userId = await findUserIdBySubject(user.subject);
      if (!userId) {
        throw new Error("expected a local user row for this subject after sign-in");
      }
      workspace = await createWorkspaceWithMembership(userId, "E2E");
      await page.goto("/");
      await page.waitForURL(`/${workspace.id}`);

      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });

  test("signs out and lands back on the sign-in screen", async ({ page }) => {
    const user = await createTestUser();
    let workspace: Awaited<ReturnType<typeof createWorkspaceWithMembership>> | undefined;
    try {
      await page.goto("/");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/realms\/envelope\/protocol\/openid-connect\/auth/);
      await page.getByLabel("Username or email").fill(user.username);
      await page.getByLabel("Password", { exact: true }).fill(user.password);
      await page.getByRole("button", { name: "Sign In" }).click();
      await page.waitForURL("/");

      await expect(page.getByText("You do not belong to any workspace yet.")).toBeVisible();
      const userId = await findUserIdBySubject(user.subject);
      if (!userId) {
        throw new Error("expected a local user row for this subject after sign-in");
      }
      workspace = await createWorkspaceWithMembership(userId, "E2E");
      await page.goto("/");
      await page.waitForURL(`/${workspace.id}`);

      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    } finally {
      await workspace?.teardown();
      await user.teardown();
    }
  });
});
