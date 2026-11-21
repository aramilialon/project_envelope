/**
 * The interface languages the app ships (ADR 0004, ADR 0009).
 *
 * The list itself is data, `locales/index.json`, so that every reader can use it without
 * TypeScript: the web app and the API through this module, the mobile app's bundler, and shell
 * scripts through `jq`. It is the one list both locale negotiation (`resolveLanguage`) and the
 * completeness check (`pnpm --filter @envelope/i18n check`) read: a catalog file in `locales/`
 * whose language is not in `shipped` is a translation in progress — never offered to a user and
 * never checked — so it can land incomplete. Adding a language to `shipped` makes it both
 * offered and required to be complete. See this package's README, "Adding a language".
 *
 * Loading a catalog stays with each app (the web app uses a dynamic `import()` per language, so
 * the bundler emits one chunk per catalog); this package only exports the JSON files and the list.
 */
import index from "../locales/index.json" with { type: "json" };

export { resolveLanguage, type DeviceLanguage, type ResolvedLanguage, type StoredLanguage } from "./resolveLanguage.ts";

/** Who reviewed a shipped catalog: the maintainer, or machine-translated and reviewed by an agent. */
export type ReviewStatus = "maintainer" | "agent";

interface LocalesIndex {
  /** The source language: every message's own `defaultMessage` is English, and `en.json` is generated from them. */
  readonly source: string;
  /** Every interface language the app offers, the source language first. */
  readonly shipped: readonly string[];
  /** The review status of every shipped language other than the source one. */
  readonly review: Readonly<Record<string, ReviewStatus>>;
}

const LOCALES_INDEX: LocalesIndex = index as LocalesIndex;

/** The source language, `"en"`. */
export const SOURCE_LOCALE: string = LOCALES_INDEX.source;

/** Every interface language the app offers (primary language subtags), the source language first. */
export const SHIPPED_LOCALES: readonly string[] = Object.freeze([...LOCALES_INDEX.shipped]);

/** The review status of each shipped language other than the source one. */
export const REVIEW_STATUS: Readonly<Record<string, ReviewStatus>> = Object.freeze({ ...LOCALES_INDEX.review });

/** A catalog: message id to ICU message. */
export type Catalog = Readonly<Record<string, string>>;
