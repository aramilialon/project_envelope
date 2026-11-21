# packages/i18n

The interface's translation catalogs and the list of languages the app ships (ADR 0004, ADR 0009). No user-facing text lives anywhere else: `packages/core` returns codes, and every app formats its messages from these catalogs.

## Contents

| Path | Contents |
| --- | --- |
| `locales/index.json` | The shipped languages: `source` (`"en"`), `shipped` (every language offered to users, the source first) and `review` (who reviewed each shipped catalog other than the source). Plain JSON, so the web app, the API, the mobile app's bundler and shell scripts (`jq -r '.shipped[]' packages/i18n/locales/index.json`) all read the same list |
| `locales/en.json` | The English catalog, the source. **Generated**, never edited by hand: `pnpm --filter @envelope/i18n extract` collects every `defaultMessage` from the sources listed in the `extract` script, sorted by id |
| `locales/<language>.json` | One catalog per other language, translated by hand from `en.json`: the same keys and the same ICU arguments |
| `src/index.ts` | `SOURCE_LOCALE`, `SHIPPED_LOCALES`, `REVIEW_STATUS` (read from `locales/index.json`) and `resolveLanguage` |
| `src/resolveLanguage.ts` | `resolveLanguage({ stored, deviceTags, shipped })`: the interface `language` (a stored choice if shipped, else the device's first shipped language, else English) and the `formattingLocale` for amounts and dates (a stored one, else the device's first preference when it carries a language and a region, such as `de-CH` but not `und-CH`, else the language). Device tags may use `_` for `-` (`it_IT`). Pure and platform-neutral: each app passes its own device languages (`navigator.languages` on the web) |
| `glossary.md` | Interface terms, form of address and tone per language; binding for the translator, checked by the ux-reviewer (ADR 0015) |
| `src/checkComplete.ts`, `src/check.ts` | The completeness check, `pnpm --filter @envelope/i18n check` |
| `extract-format.mjs` | The `@formatjs/cli extract` formatter that flattens its output into the plain `{ id: message }` shape of `en.json` |

The package exports `.` (`src/index.ts`) and every catalog as `@envelope/i18n/locales/<file>.json`. Loading a catalog at run time is each app's own job: the web app imports each one with a dynamic `import()` (`apps/web/src/i18n/catalogs.ts`), so its build emits one chunk per language and a browser downloads only the one it uses.

## Shipped and not shipped

A catalog file in `locales/` whose language is not in `shipped` is a translation in progress: users are never offered it, and nothing checks it, so it can be committed incomplete while it is being written. Once its language is in `shipped`, it is offered to every user whose browser or device prefers it, and the completeness check requires it to be complete.

## The completeness check

`pnpm --filter @envelope/i18n check` reads `locales/index.json` and, for every shipped catalog other than English, reports:

- a key `en.json` has and the catalog does not (`missingInTarget`), and a key the catalog has and `en.json` no longer does (`staleInTarget`);
- a message whose ICU arguments differ from the English one, however deep inside a plural, select or tag they sit (`argumentMismatch`);

and, in every shipped catalog, English included:

- a plural or select without an `other` branch (`missingOtherBranch`): each language has its own plural categories, and `other` is the branch every value falls back to;
- a message that does not parse (`invalidMessage`).

It exits with a non-zero status on any problem. It is not part of `pnpm test`, so a catalog in progress never turns the test suite red; CI runs it as a step of its own, next to a check that `pnpm --filter @envelope/i18n extract` leaves `en.json` unchanged. `pnpm test` runs the checker's own unit tests, and `apps/web`'s `catalogs.test.ts` formats every message of every shipped catalog with sample arguments.

## Adding a source of messages

The `extract` script in `package.json` lists the source globs every message is collected from (`apps/web/src` today). A new app that uses the same catalogs adds its own glob there, and its messages join the one `en.json`.

## Adding a language

1. Write `locales/<language>.json` (primary language subtag: `de`, `es`, `fr`) with every key of `en.json`, keeping every ICU argument and an `other` branch in every plural and select. While it is in progress, leave it out of `shipped`.
2. When it is complete, add the language to `shipped` and its review status to `review` in `locales/index.json`.
3. Add its loader to `CATALOG_LOADERS` in `apps/web/src/i18n/catalogs.ts` (`catalogs.test.ts` fails until it is there).
4. Run `pnpm --filter @envelope/i18n check` and `pnpm --filter @envelope/web test`.
   Tests must not depend on the real shipped list: a test about which languages are offered passes its own explicit list (`resolveLanguage`'s `shipped`, `negotiateLocale`'s second argument), so shipping a language never turns an unrelated test red. Only tests that are about the real list itself (a loader and a complete catalog for every shipped language) read `SHIPPED_LOCALES`.
5. Push notifications (`apps/api/src/notifications/budget-alert-text.ts`) have their own wording in English and Italian only; other languages get English until notifications have a language setting.

## Review status

| Language | Catalog | Status |
| --- | --- | --- |
| English (`en`) | `en.json` | Source language, generated from the code |
| Italian (`it`) | `it.json` | Reviewed by the maintainer |
| German (`de`), Spanish (`es`), French (`fr`) | not written yet | Will be machine-translated and agent-reviewed; corrections welcome |

`review` in `locales/index.json` records the same: `"maintainer"`, or `"agent"` for a machine-translated, agent-reviewed catalog. The status is stated here and in the catalog index only, never in the app itself.
