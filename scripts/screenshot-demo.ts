import { chromium } from "@playwright/test";

import { assertSafeToRun, requireEnv } from "./lib/env.ts";

/**
 * Regenerates the reference screenshots from the already-seeded "Demo" workspace (`seed-demo.ts`
 * must have run first): the budget month (this month and the previous one, #326), the accounts
 * list and the account register, light and dark, at 1440px/390px/360px, named after
 * `docs/ux/screenshots/budget-month-*.png`/`account-register.png`'s existing convention (with a
 * size suffix, since those were only ever one size). Saved **outside** the repository, for manual
 * review — `#323`'s own real-app screenshots followed the same rule; see `scripts/README.md` for
 * why and for the exact command.
 *
 * Also asserts there is no horizontal overflow at 390px/360px on any of the four screens (`#333`'s
 * own acceptance criterion, extended to the budget month by `#326`:
 * `document.documentElement.scrollWidth <= clientWidth`), failing loudly (non-zero exit) if any
 * does — the same check a reviewer would otherwise have to do by hand with the browser's own dev
 * tools.
 *
 * Needs a real browser: unlike `seed-demo.ts`'s own plain-`fetch` PKCE handshake, actually
 * rendering pixels needs `apps/web` running too (not just `apps/api`), so this drives the real
 * sign-in form through Playwright instead.
 */

const WEB_URL = "http://localhost:5173";
const DEMO_USERNAME = "demo";
const PHONE_WIDTHS = [390, 360] as const;

interface OverflowCheck {
  readonly label: string;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly ok: boolean;
}

async function checkOverflow(page: import("@playwright/test").Page, label: string): Promise<OverflowCheck> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  return { label, scrollWidth, clientWidth, ok: scrollWidth <= clientWidth };
}

async function main(): Promise<void> {
  const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3000";
  const keycloakUrl = process.env.KEYCLOAK_URL ?? "http://127.0.0.1:8080";
  const databaseUrl = requireEnv("DATABASE_URL");
  const demoPassword = requireEnv("DEMO_USER_PASSWORD");
  const outDir = `${requireEnv("HOME")}/screenshots`;
  // This script itself only ever talks to apps/web's own origin (hard-coded, already local) —
  // every one of these is still checked for the same reason seed-demo.ts checks all three it
  // actually uses: one shared, consistent safety contract on the one .env both scripts read.
  assertSafeToRun({ API_URL: apiUrl, DATABASE_URL: databaseUrl, KEYCLOAK_URL: keycloakUrl });

  const overflowChecks: OverflowCheck[] = [];
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
    await shootSixWays(page, outDir, "budget-month", overflowChecks);

    await page.getByRole("button", { name: "Previous month" }).click();
    await page.getByText("Unassigned").waitFor();
    await shootSixWays(page, outDir, "budget-month-previous", overflowChecks);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("link", { name: "Accounts" }).click();
    await page.getByRole("heading", { name: "Accounts" }).waitFor();
    await shootSixWays(page, outDir, "accounts", overflowChecks);

    await page.getByRole("button", { name: "Checking" }).click();
    await page.waitForURL(/\/accounts\/.+/);
    await page.getByRole("heading", { name: "Checking" }).waitFor();
    await shootSixWays(page, outDir, "account-register", overflowChecks);

    console.log("Screenshots written to", outDir);
    console.log("\nAnti-overflow check (document.documentElement.scrollWidth <= clientWidth):");
    let anyOverflow = false;
    for (const check of overflowChecks) {
      console.log(`  ${check.ok ? "OK  " : "FAIL"} ${check.label}: scrollWidth=${check.scrollWidth} clientWidth=${check.clientWidth}`);
      if (!check.ok) {
        anyOverflow = true;
      }
    }
    if (anyOverflow) {
      throw new Error("Horizontal overflow detected (see above) — #333's own acceptance criterion");
    }
  } finally {
    await browser.close();
  }
}

/** Light/dark at 1440px, then light/dark at each of `PHONE_WIDTHS` — checking for horizontal overflow once per width, before either theme's screenshot. */
async function shootSixWays(page: import("@playwright/test").Page, outDir: string, baseName: string, overflowChecks: OverflowCheck[]): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: `${outDir}/${baseName}-light-1440.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: `${outDir}/${baseName}-dark-1440.png` });

  for (const width of PHONE_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    // A screen with its own phone-width render (not just a CSS reflow, e.g. the account
    // register's table vs. day list, #333) picks it from a `resize` event listener — one tick
    // behind `setViewportSize` itself. Without this, the check below can race ahead and measure
    // the previous (wider) layout even though the screenshot right after it is already correct.
    await page.waitForTimeout(50);
    overflowChecks.push(await checkOverflow(page, `${baseName} @ ${width}px`));
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: `${outDir}/${baseName}-light-${width}.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: `${outDir}/${baseName}-dark-${width}.png` });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
}

await main();
