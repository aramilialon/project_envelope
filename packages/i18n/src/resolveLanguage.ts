/**
 * Locale negotiation, the same on every platform (#620): the web app passes
 * `navigator.languages`, the mobile app its own device locales, and neither decides anything
 * on its own. Pure: it never reads `navigator` or any other global.
 *
 * Two answers, kept apart on purpose:
 * - `language`, the interface language: which catalog to show and whose plural rules apply.
 *   Always a shipped language.
 * - `formattingLocale`, a full BCP 47 tag for amounts, numbers and dates. Someone in
 *   Switzerland whose device says `de-CH` while German is not shipped yet reads the interface
 *   in English but still sees `1'234.56`, the way their bank shows it.
 */

/** A user's stored choice (a future "your account" setting); `null` while there is none. */
export interface StoredLanguage {
  /** A shipped interface language, `"it"`; `null` to follow the device. */
  readonly language: string | null;
  /** A full tag for amounts and dates, `"it-CH"`; `null` to follow the device. */
  readonly formattingLocale: string | null;
}

/** One of the device's ordered language preferences, as the platform reports it (`"de-CH"`, `"it"`). */
export type DeviceLanguage = string;

export interface ResolvedLanguage {
  /** The interface language: a primary language subtag from the shipped list. */
  readonly language: string;
  /** The locale for amounts, numbers and dates: a canonical BCP 47 tag. */
  readonly formattingLocale: string;
}

/**
 * The canonical form of a tag (`"DE-ch"` → `"de-CH"`), or null when it is not a valid one. An
 * underscore is read as a hyphen first: some platforms report POSIX-style tags (`"it_IT"`).
 */
function canonical(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag.trim().replaceAll("_", "-"))[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a (canonical) tag can format amounts and dates by itself: it names a real language.
 * `und-CH` says where, not which language, so it is no formatting locale of its own.
 */
function namesLanguage(tag: string): boolean {
  // `Intl.Locale` reports the `und` language as `undefined` in some engines and `"und"` in others.
  const language = new Intl.Locale(tag).language as string | undefined;
  return language !== undefined && language !== "und";
}

function primaryLanguage(tag: string): string {
  return tag.split("-")[0]!.toLowerCase();
}

/**
 * - `language`: the stored choice if it is shipped; else the first device language whose primary
 *   subtag is shipped, in the device's own order (`["fr", "it", "en"]` picks Italian while French
 *   is not shipped); else the source language, the first entry of `shipped` (English).
 * - `formattingLocale`: the stored choice if it is a valid tag naming a language; else the
 *   device's first preference when it is a full tag with a language and a region (`de-CH`,
 *   `en-GB`; not `und-CH`); else the interface language itself.
 *
 * Device tags may use `_` for `-` (`it_IT`).
 */
export function resolveLanguage(input: {
  readonly stored: StoredLanguage | null;
  readonly deviceTags: readonly DeviceLanguage[];
  /** The shipped interface languages, the source language first (`SHIPPED_LOCALES`). */
  readonly shipped: readonly string[];
}): ResolvedLanguage {
  const { stored, deviceTags, shipped } = input;
  const device = deviceTags.map(canonical).filter((tag): tag is string => tag !== null);

  const storedLanguage = stored?.language ? primaryLanguage(stored.language) : null;
  const language =
    (storedLanguage !== null && shipped.includes(storedLanguage) ? storedLanguage : undefined) ??
    device.map(primaryLanguage).find((primary) => shipped.includes(primary)) ??
    shipped[0] ??
    "en";

  const storedCanonical = stored?.formattingLocale ? canonical(stored.formattingLocale) : null;
  const storedFormatting = storedCanonical !== null && namesLanguage(storedCanonical) ? storedCanonical : null;
  const firstDevice = device[0];
  const deviceFormatting =
    firstDevice !== undefined && namesLanguage(firstDevice) && new Intl.Locale(firstDevice).region !== undefined
      ? firstDevice
      : null;
  const formattingLocale = storedFormatting ?? deviceFormatting ?? language;

  return { language, formattingLocale };
}
