import { expect, test } from "@playwright/test";

import { createTestUser } from "./keycloak-test-user.ts";

/**
 * Drives a real headless Chromium through sign-in (#49) against the real "envelope" Keycloak
 * realm — the one thing #49's own committed suite could not cover (its unit tests mock
 * `react-oidc-context`'s `useAuth` entirely). Needs `apps/api` and Keycloak already running
 * (`infra/docker-compose.yml`); see `e2e/README.md`.
 */
test.describe("sign-in (#49)", () => {
  test("signs in through Keycloak and reaches the authenticated screen", async ({ page }) => {
    const user = await createTestUser();
    try {
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      await page.getByRole("button", { name: "Sign in" }).click();

      // Keycloak's own login form, not this app's.
      await page.waitForURL(/\/realms\/envelope\/protocol\/openid-connect\/auth/);
      await page.getByLabel("Username or email").fill(user.username);
      await page.getByLabel("Password", { exact: true }).fill(user.password);
      await page.getByRole("button", { name: "Sign In" }).click();

      // Back on the app, authenticated.
      await page.waitForURL("/");
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    } finally {
      await user.teardown();
    }
  });

  test("signs out and lands back on the sign-in screen", async ({ page }) => {
    const user = await createTestUser();
    try {
      await page.goto("/");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/realms\/envelope\/protocol\/openid-connect\/auth/);
      await page.getByLabel("Username or email").fill(user.username);
      await page.getByLabel("Password", { exact: true }).fill(user.password);
      await page.getByRole("button", { name: "Sign In" }).click();
      await page.waitForURL("/");

      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    } finally {
      await user.teardown();
    }
  });
});
