import { expect, test } from "@playwright/test";

import { usesDisposableEnvironment } from "./environment.ts";

/**
 * The interface language follows the browser's own preference (#62, #620), in a real browser and
 * a real build: only the negotiated language's catalog is downloaded, and `<html lang>` follows
 * it. The sign-in screen needs no user or workspace, so nothing is created here.
 */
test.describe("the interface language (#620)", () => {
  test.describe("with an Italian browser", () => {
    test.use({ locale: "it-IT" });

    test("shows the sign-in screen in Italian", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Accedi" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", "it");
    });

    test("shows Italian offline once the service worker has precached the catalog", async ({ page, context }) => {
      test.skip(!usesDisposableEnvironment, "the dev server registers no service worker; a disposable environment's build does");
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Accedi" })).toBeVisible();
      // A string, run in the page: e2e/ is type-checked for Node (no DOM lib), where `navigator`
      // has no `serviceWorker`.
      await page.evaluate("navigator.serviceWorker.ready.then(() => undefined)");
      await context.setOffline(true);
      try {
        await page.reload();
        await expect(page.getByRole("button", { name: "Accedi" })).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("lang", "it");
      } finally {
        await context.setOffline(false);
      }
    });

    test.describe("without the Italian catalog", () => {
      // Requests a service worker makes are not routed through the page, so keep it out of the way.
      test.use({ serviceWorkers: "block" });

      test("still starts, in English, when the Italian catalog cannot be downloaded", async ({ page }) => {
        const aborted: string[] = [];
        // The production build's chunk (`/assets/it-<hash>.js`), or the dev server's own module.
        const catalog = /\/assets\/it-[^/]*\.js(\?|$)|\/locales\/it\.json(\?|$)/;
        await page.route(catalog, async (route) => {
          aborted.push(route.request().url());
          await route.abort();
        });
        await page.goto("/");
        await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        expect(aborted.length, "the Italian catalog was requested and aborted").toBeGreaterThan(0);
      });
    });
  });

  test.describe("with a browser in a language that is not shipped", () => {
    // Japanese is not planned, so this stays a language the app does not offer.
    test.use({ locale: "ja-JP" });

    test("shows the sign-in screen in English", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
    });
  });
});
