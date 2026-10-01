import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (#63 and this one's own scope: proving #49's sign-in actually round-trips
 * through a real Keycloak, not just a mocked `useAuth()`) drive a real headless Chromium against
 * the dev server and the real "envelope" Keycloak realm — see `e2e/README.md`. `webServer`
 * starts `apps/web`'s own dev server for the run; `apps/api` and Keycloak are expected to
 * already be running (`infra/docker-compose.yml`), same as any other local development.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
