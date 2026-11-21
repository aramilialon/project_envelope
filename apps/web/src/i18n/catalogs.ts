import { SOURCE_LOCALE, type Catalog } from "@envelope/i18n";

/**
 * One loader per shipped interface language other than English, each a dynamic `import()` so the
 * production build emits every catalog as a chunk of its own and a browser downloads only the one
 * it needs (#620); the service worker precaches them all (`vite.config.ts`), so offline still
 * works in every language. A language added to `packages/i18n/locales/index.json` needs its line
 * here too: `catalogs.test.ts` fails until it has one.
 */
export const CATALOG_LOADERS: Readonly<Record<string, () => Promise<{ default: Catalog }>>> = {
  it: () => import("@envelope/i18n/locales/it.json"),
};

/**
 * The messages to hand to `IntlProvider` for an interface language. English has no runtime
 * catalog: every component's own `defaultMessage` already *is* the English text, so relying on it
 * (rather than a second, generated copy that could drift out of sync) is the one copy that can
 * never go stale.
 */
export async function loadCatalog(language: string): Promise<Catalog> {
  if (language === SOURCE_LOCALE) {
    return {};
  }
  const loader = CATALOG_LOADERS[language];
  if (loader === undefined) {
    throw new Error(`loadCatalog: no catalog loader for "${language}"`);
  }
  return (await loader()).default;
}
