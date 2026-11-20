import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser } from "@playwright/test";

/**
 * Renders the reference screenshots that come from the mockups (`docs/ux/mockups/*.html`) rather
 * than from the real app, in both themes, plus the README's two mixed showcase images, straight
 * into `docs/ux/screenshots/` (#587):
 *
 * - `portfolio-{light,dark}.png`: the portfolio mockup's desktop view, cropped to its app frame
 *   at 1440 x 900 (there is no portfolio screen in the app yet);
 * - `phones-{light,dark}.png`: three phone screens side by side — the budget month, the account
 *   register and the portfolio, each at the mockups' own 390px phone width;
 * - `phones-mixed.png`: the same three phones, light, dark and light;
 * - `budget-month-split.png`: `budget-month-light.png` and `budget-month-dark.png` (which come from
 *   the real app, `screenshot-demo.ts`, so run that and copy them in first) split along a
 *   diagonal, light at the top left, dark at the bottom right.
 *
 * The phones are made in two steps. Each phone screen is first rendered on its own, per theme,
 * as an intermediate PNG with a transparent page around the phone (in a temporary directory);
 * then one plain HTML page places those PNGs side by side and is screenshotted once. The
 * composite's background is the mockups' own `--desk` token, read from the rendered mockup, so it
 * never carries a colour of its own; with transparent corners, a phone of either theme sits on
 * either background.
 *
 * Mockups are opened with `file://` (no server); the theme is chosen with `prefers-color-scheme`,
 * which every mockup follows. The mockups load their fonts from the web, so this needs a network
 * connection. See `scripts/README.md`, "Reference screenshots".
 */

const REPO_ROOT = new URL("../", import.meta.url);
const MOCKUPS = new URL("docs/ux/mockups/", REPO_ROOT);
const OUT_DIR = new URL("docs/ux/screenshots/", REPO_ROOT);

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

/** The gap between the phones and around them, as in the earlier `phones.png`. */
const PHONE_GAP = 30;

interface PhoneScreen {
  readonly name: string;
  readonly mockup: string;
  /** Clicks that lead from the mockup's phone view to the screen to show, in order. */
  readonly clicks: readonly string[];
}

const PHONE_SCREENS: readonly PhoneScreen[] = [
  { name: "budget-month", mockup: "budget-month.html", clicks: [] },
  { name: "account-register", mockup: "account-register.html", clicks: ['[data-phscreen="register"]'] },
  { name: "portfolio", mockup: "portfolio.html", clicks: [] },
];

/** The theme of each phone in `phones-mixed.png`, in the order of `PHONE_SCREENS`. */
const MIXED_PHONE_THEMES: readonly Theme[] = ["light", "dark", "light"];
/** The background of `phones-mixed.png`: the `--desk` token of this theme. */
const MIXED_BACKGROUND_THEME: Theme = "light";

/**
 * Where the light/dark seam of `budget-month-split.png` meets the top and the bottom edge, in
 * pixels from the left of the 1440 x 900 screenshot. Chosen against the budget month's layout so
 * the seam runs through gutters: between the navigation and the workspace menu in the band, between
 * the unassigned money card and the facts beside it, across the timeline's chart, past the
 * buttons and through the category bars, crossing only the timeline's one-line caption as text.
 * Revisit when the budget month's layout changes.
 */
const SPLIT_SEAM = { top: 705, bottom: 295 } as const;

function mockupUrl(file: string): string {
  return new URL(file, MOCKUPS).href;
}

function outPath(file: string): string {
  return new URL(file, OUT_DIR).pathname;
}

async function dataUrl(file: string): Promise<string> {
  return `data:image/png;base64,${(await readFile(file)).toString("base64")}`;
}

async function newThemedPage(browser: Browser, theme: Theme, width: number, height: number) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  const page = await context.newPage();
  return { context, page };
}

/** The portfolio's desktop frame (`#desk`), 1440 x 900 from its top-left corner. */
async function shootPortfolio(browser: Browser, theme: Theme): Promise<void> {
  // The page's own 16px side padding, either side of a 1440px frame.
  const { context, page } = await newThemedPage(browser, theme, 1440 + 32, 900);
  try {
    await page.goto(mockupUrl("portfolio.html"));
    await page.evaluate(() => document.fonts.ready);
    const box = await page.locator("#desk").boundingBox();
    if (!box) {
      throw new Error("portfolio.html: the desktop frame (#desk) is not visible");
    }
    await page.screenshot({ path: outPath(`portfolio-${theme}.png`), fullPage: true, clip: { x: box.x, y: box.y, width: 1440, height: 900 } });
  } finally {
    await context.close();
  }
}

interface PhoneShot {
  readonly file: string;
  /** The mockup's `--desk` token in this theme. */
  readonly desk: string;
}

/** One phone screen as an intermediate PNG, transparent around the phone's rounded corners. */
async function shootPhone(browser: Browser, theme: Theme, screen: PhoneScreen, dir: string): Promise<PhoneShot> {
  const { context, page } = await newThemedPage(browser, theme, 1440, 1000);
  try {
    await page.goto(mockupUrl(screen.mockup));
    await page.evaluate(() => document.fonts.ready);
    await page.click("#tab-phone");
    for (const selector of screen.clicks) {
      await page.click(`#view-phone ${selector}`);
    }
    const desk = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--desk").trim());
    await page.addStyleTag({ content: "html,body{background:transparent !important}" });
    const file = join(dir, `phone-${screen.name}-${theme}.png`);
    await page.locator("#view-phone .phone").first().screenshot({ path: file, omitBackground: true });
    return { file, desk };
  } finally {
    await context.close();
  }
}

/** Places `files` side by side on `background` and saves the result to `out`. */
async function composePhones(browser: Browser, files: readonly string[], background: string, out: string): Promise<void> {
  const images = await Promise.all(files.map(dataUrl));
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0}body{display:inline-flex;align-items:flex-start;gap:${PHONE_GAP}px;padding:${PHONE_GAP}px;background:${background}}img{display:block}` +
    `</style></head><body>${images.map((src) => `<img alt="" src="${src}">`).join("")}</body></html>`;
  const context = await browser.newContext({ viewport: { width: 400, height: 400 } });
  try {
    const page = await context.newPage();
    await page.setContent(html);
    await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));
    await page.locator("body").screenshot({ path: out });
  } finally {
    await context.close();
  }
}

/**
 * The dark render under the light one, the light one masked to the part left of the seam from
 * (`seam.top`, 0) to (`seam.bottom`, height): one screenshot, no line or shadow on the seam.
 */
async function composeSplit(browser: Browser, lightFile: string, darkFile: string, seam: { top: number; bottom: number }, out: string): Promise<void> {
  const [light, dark] = await Promise.all([dataUrl(lightFile), dataUrl(darkFile)]);
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0}#split{position:relative;display:inline-block}img{display:block}` +
    `#light{position:absolute;top:0;left:0;clip-path:polygon(0 0,${seam.top}px 0,${seam.bottom}px 100%,0 100%)}` +
    `</style></head><body><div id="split"><img alt="" src="${dark}"><img id="light" alt="" src="${light}"></div></body></html>`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.setContent(html);
    const sizes = await page.evaluate(async () => {
      const images = [...document.images];
      await Promise.all(images.map((img) => img.decode()));
      return images.map((img) => `${img.naturalWidth}x${img.naturalHeight}`);
    });
    if (sizes[0] !== sizes[1]) {
      throw new Error(`budget-month-light.png and budget-month-dark.png differ in size (${sizes.join(" vs ")})`);
    }
    await page.locator("#split").screenshot({ path: out });
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "envelope-mockup-shots-"));
  const browser = await chromium.launch();
  try {
    const phones = new Map<Theme, PhoneShot[]>();
    for (const theme of THEMES) {
      await shootPortfolio(browser, theme);

      const shots: PhoneShot[] = [];
      for (const screen of PHONE_SCREENS) {
        shots.push(await shootPhone(browser, theme, screen, workDir));
      }
      phones.set(theme, shots);
      await composePhones(
        browser,
        shots.map((s) => s.file),
        shots[0]!.desk,
        outPath(`phones-${theme}.png`),
      );
    }

    const mixed = MIXED_PHONE_THEMES.map((theme, i) => phones.get(theme)![i]!.file);
    await composePhones(browser, mixed, phones.get(MIXED_BACKGROUND_THEME)![0]!.desk, outPath("phones-mixed.png"));

    await composeSplit(browser, outPath("budget-month-light.png"), outPath("budget-month-dark.png"), SPLIT_SEAM, outPath("budget-month-split.png"));

    console.log("Screenshots written to", OUT_DIR.pathname);
  } finally {
    await browser.close();
    await rm(workDir, { recursive: true, force: true });
  }
}

await main();
