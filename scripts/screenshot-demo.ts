import { chromium } from "@playwright/test";

import { assertSafeToRun, requireEnv } from "./lib/env.ts";
import { keycloakTargetFromEnv } from "./lib/keycloak.ts";

/**
 * Regenerates the reference screenshots from the already-seeded "Demo" workspace (`seed-demo.ts`
 * must have run first): the budget month (this month and the previous one, #326), the accounts
 * list and the account register, light and dark, at 1440px/390px/360px (plus the accounts panel,
 * #412, open over that register, and the reconciliation screen for that account, with a statement
 * balance that leaves exactly the pending transaction as the difference: desktop only, so 1440px
 * alone; and the sign-in screen and, when the demo user has a second workspace —
 * `seed-demo.ts --second-workspace` — the workspace picker, at 900 x 700, #587), named
 * `<screen>-<theme>-<width>.png` (the committed copies in `docs/ux/screenshots/` drop the width).
 * Saved **outside** the repository, for manual review; see `scripts/README.md` for the exact
 * commands, against the shared stack or a disposable environment (`KEYCLOAK_REALM`, `WEB_URL`).
 *
 * Also asserts there is no horizontal overflow at 390px/360px on any of the four screens (`#333`'s
 * own acceptance criterion, extended to the budget month by `#326`:
 * `document.documentElement.scrollWidth <= clientWidth`), failing loudly (non-zero exit) if any
 * does — the same check a reviewer would otherwise have to do by hand with the browser's own dev
 * tools. The account register's own phone list also gets a WCAG contrast check on its payee text
 * (`#349`: a stray `.who` class collision once left it reading the band's own muted colour instead
 * of `--ink`) — >= 4.5:1 against the page background, in both themes.
 *
 * Needs a real browser: unlike `seed-demo.ts`'s own plain-`fetch` PKCE handshake, actually
 * rendering pixels needs `apps/web` running too (not just `apps/api`), so this drives the real
 * sign-in form through Playwright instead.
 */

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

interface ContrastCheck {
  readonly label: string;
  readonly ratio: number;
  readonly ok: boolean;
}

/** WCAG 2.2 relative luminance and contrast ratio, from two `getComputedStyle`-style `rgb(r, g, b)` strings. */
function contrastRatio(foreground: string, background: string): number {
  function channel(c: number): number {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }
  function luminance(rgb: string): number {
    const [r, g, b] = rgb.match(/\d+/g)!.map(Number) as [number, number, number];
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }
  const l1 = luminance(foreground);
  const l2 = luminance(background);
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

async function checkContrast(page: import("@playwright/test").Page, label: string, selector: string): Promise<ContrastCheck | null> {
  const colors = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) {
      return null;
    }
    return { foreground: getComputedStyle(el).color, background: getComputedStyle(document.body).backgroundColor };
  }, selector);
  if (!colors) {
    return null;
  }
  const ratio = contrastRatio(colors.foreground, colors.background);
  return { label, ratio, ok: ratio >= 4.5 };
}

async function main(): Promise<void> {
  const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3000";
  const keycloakUrl = process.env.KEYCLOAK_URL ?? "http://127.0.0.1:8080";
  const databaseUrl = requireEnv("DATABASE_URL");
  const demoPassword = requireEnv("DEMO_USER_PASSWORD");
  const outDir = `${requireEnv("HOME")}/screenshots`;
  // The shared stack's realm and Vite dev server by default; a disposable environment's own
  // (`KEYCLOAK_REALM`, `WEB_URL`, from its manifest) otherwise — scripts/README.md.
  const { realm, redirectUri: webUrl } = keycloakTargetFromEnv();
  // This script itself only ever talks to apps/web's own origin (hard-coded, already local) —
  // every one of these is still checked for the same reason seed-demo.ts checks all three it
  // actually uses: one shared, consistent safety contract on the one .env both scripts read.
  assertSafeToRun({ API_URL: apiUrl, DATABASE_URL: databaseUrl, KEYCLOAK_URL: keycloakUrl, WEB_URL: webUrl });

  const overflowChecks: OverflowCheck[] = [];
  const contrastChecks: ContrastCheck[] = [];
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL: webUrl, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // The sign-in screen (a centred card), at the size its earlier screenshot had.
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await shootBothThemes(page, outDir, "sign-in", 900);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => url.pathname.startsWith(`/realms/${realm}/protocol/openid-connect/auth`));
    await page.getByLabel("Username or email").fill(DEMO_USERNAME);
    await page.getByLabel("Password", { exact: true }).fill(demoPassword);
    await page.getByRole("button", { name: "Sign In" }).click();

    // With more than one workspace (and a fresh browser, which remembers none), "/" stops at the
    // workspace picker: shoot it, then go on into "Demo".
    const picker = page.getByText("Choose a workspace to work in.");
    await picker.or(page.getByText("Unassigned")).first().waitFor();
    if (await picker.isVisible()) {
      await page.setViewportSize({ width: 900, height: 700 });
      await shootBothThemes(page, outDir, "workspace-picker", 900);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole("button", { name: "Demo", exact: true }).click();
    }
    await page.waitForURL((url) => /^\/[0-9a-f-]+$/.test(url.pathname));

    await page.getByText("Unassigned").waitFor();
    // The "To do" list's own target-funding entry and the timeline's own events are each a
    // separate, parallel fetch on top of the budget month itself (#326) — without this, a
    // screenshot can catch it mid-flight, one or two "To do" items short of its own final count,
    // or the timeline with no marks at all. `networkidle` alone is not quite enough: it settles
    // the instant the last response arrives, which can still be a tick before React has committed
    // the re-render those fetches triggered — the same kind of gap `waitForTimeout(50)` already
    // closes elsewhere in this file, for a resize instead of a fetch.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    await shootSixWays(page, outDir, "budget-month", overflowChecks, contrastChecks);

    await page.getByRole("button", { name: "Previous month" }).click();
    await page.getByText("Unassigned").waitFor();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    await shootSixWays(page, outDir, "budget-month-previous", overflowChecks, contrastChecks);

    await page.setViewportSize({ width: 1440, height: 900 });
    // The band's own navigation, not the phone tab bar's: just back from 360px, that one can still
    // be mounted a tick behind the resize, and its "Accounts" link would match too.
    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Accounts" }).click();
    await page.getByRole("heading", { name: "Accounts" }).waitFor();
    await shootSixWays(page, outDir, "accounts", overflowChecks, contrastChecks);

    await page.getByRole("button", { name: "Checking" }).click();
    await page.waitForURL(/\/accounts\/.+/);
    await page.getByRole("heading", { name: "Checking" }).waitFor();
    await shootSixWays(page, outDir, "account-register", overflowChecks, contrastChecks, ".ph-tx .what b");

    // Reconciliation (#60), for the same account, at the size its earlier screenshot had: a
    // statement balance of the cleared balance plus the first pending transaction, so the
    // difference is exactly that transaction and the screen shows its clue. Typing the balance is
    // all this does: nothing is locked or recorded.
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.getByRole("link", { name: "Reconcile", exact: true }).click();
    await page.getByRole("heading", { name: "Reconcile with your bank" }).waitFor();
    await page.waitForLoadState("networkidle");
    const clearedCents = parseCents(await page.locator(".recon .qa.total .n").innerText());
    const pendingCents = parseCents(await page.locator(".rlist .sec").nth(1).locator(".n.r").first().innerText());
    await page.locator("#rec-amt").fill(((clearedCents + pendingCents) / 100).toFixed(2));
    await page.locator("#rec-amt").blur();
    await page.waitForTimeout(300);
    await shootBothThemes(page, outDir, "reconciliation", 1440);
    await page.locator(".crumb-back").click();
    await page.getByRole("heading", { name: "Checking" }).waitFor();

    // The accounts panel (#412), open over the register it just switched to: desktop only, like
    // its own mockup (it has no toggle below 600px), so light and dark at 1440px and nothing else.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Show accounts" }).click();
    await page.getByRole("heading", { name: "Net worth" }).waitFor();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    await shootBothThemes(page, outDir, "accounts-panel", 1440);

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

    console.log("\nContrast check (payee text vs. page background, WCAG 2.2, >= 4.5:1):");
    let anyLowContrast = false;
    for (const check of contrastChecks) {
      console.log(`  ${check.ok ? "OK  " : "FAIL"} ${check.label}: ${check.ratio.toFixed(2)}:1`);
      if (!check.ok) {
        anyLowContrast = true;
      }
    }
    if (anyLowContrast) {
      throw new Error("Contrast below 4.5:1 detected (see above) — #349's own acceptance criterion");
    }
  } finally {
    await browser.close();
  }
}

/** An amount as the app shows it ("€1,234.56", "-€9.99") in cents. */
function parseCents(text: string): number {
  const digits = text.replace(/\D/g, "");
  if (!digits) {
    throw new Error(`Not an amount: "${text}"`);
  }
  return (/[-\u2212]/.test(text) ? -1 : 1) * Number(digits);
}

/** The page as it is, light then dark, as `<baseName>-<scheme>-<width>.png`; leaves it light. */
async function shootBothThemes(page: import("@playwright/test").Page, outDir: string, baseName: string, width: number): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `${outDir}/${baseName}-${scheme}-${width}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/**
 * Light/dark at 1440px, then light/dark at each of `PHONE_WIDTHS` — checking for horizontal
 * overflow once per width, before either theme's screenshot, and contrast once per theme when
 * `contrastSelector`/`contrastLabel` are given (an element only the phone layout renders, so
 * there is nothing to check at 1440px).
 */
async function shootSixWays(
  page: import("@playwright/test").Page,
  outDir: string,
  baseName: string,
  overflowChecks: OverflowCheck[],
  contrastChecks: ContrastCheck[],
  contrastSelector?: string,
): Promise<void> {
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
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${outDir}/${baseName}-${scheme}-${width}.png` });
      if (contrastSelector) {
        const check = await checkContrast(page, `${baseName} payee @ ${width}px (${scheme})`, contrastSelector);
        if (check) {
          contrastChecks.push(check);
        }
      }
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
}

await main();
