import { chromium } from "@playwright/test";

import { assertSafeToRun, requireEnv } from "./lib/env.ts";

/**
 * Regenerates the reference screenshots from the already-seeded "Demo" workspace (`seed-demo.ts`
 * must have run first): the budget month and the account register, light and dark, 1440px and
 * 390px, named after `docs/ux/screenshots/budget-month-*.png`/`account-register.png`'s existing
 * convention (with a size suffix, since those were only ever one size). Saved **outside** the
 * repository, for manual review — `#323`'s own real-app screenshots followed the same rule; see
 * `scripts/README.md` for why and for the exact command.
 *
 * Needs a real browser: unlike `seed-demo.ts`'s own plain-`fetch` PKCE handshake, actually
 * rendering pixels needs `apps/web` running too (not just `apps/api`), so this drives the real
 * sign-in form through Playwright instead.
 */

const WEB_URL = "http://localhost:5173";
const DEMO_USERNAME = "demo";

async function main(): Promise<void> {
  const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3000";
  const demoPassword = requireEnv("DEMO_USER_PASSWORD");
  const outDir = `${requireEnv("HOME")}/screenshots`;
  assertSafeToRun(apiUrl);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL: WEB_URL, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/realms\/envelope\/protocol\/openid-connect\/auth/);
    await page.getByLabel("Username or email").fill(DEMO_USERNAME);
    await page.getByLabel("Password", { exact: true }).fill(demoPassword);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/^http:\/\/localhost:5173\/[0-9a-f-]+$/);

    await page.getByText("Unassigned").waitFor();
    await shootThreeWays(page, outDir, "budget-month");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("link", { name: "Accounts" }).click();
    await page.getByRole("button", { name: "Checking" }).click();
    await page.waitForURL(/\/accounts\/.+/);
    await page.getByRole("heading", { name: "Checking" }).waitFor();
    await shootThreeWays(page, outDir, "account-register");

    console.log("Screenshots written to", outDir);
  } finally {
    await browser.close();
  }
}

async function shootThreeWays(page: import("@playwright/test").Page, outDir: string, baseName: string): Promise<void> {
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: `${outDir}/${baseName}-light-1440.png` });

  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: `${outDir}/${baseName}-dark-1440.png` });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${outDir}/${baseName}-light-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
}

await main();
