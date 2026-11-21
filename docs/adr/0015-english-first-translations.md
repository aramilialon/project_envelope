# 0015 — English mockups, four required translations, an agent translator

- **Status:** accepted
- **Date:** 2026-11-21
- **Supersedes:** the "Languages" section of [ADR 0004](0004-internationalization.md). The rest of ADR 0004, and [ADR 0009](0009-i18n-library.md), stand.

## Context

ADR 0004 made English the source language and Italian the first translation, always complete. The mockups in `docs/ux/mockups/` carry the Italian copy, and the developer writes `packages/i18n/locales/it.json` by hand while building a screen.

The maintainer wants German, Spanish and French as well. The maintainer cannot review those three languages, and with the current flow every change to the interface would need four translations written by the developer, from mockups written in a language other than the source.

## Decision

### English is the source, from the mockup on

- English stays the source language. The mockups in `docs/ux/mockups/` are written in English (#622), so every string goes from the mockup into a `defaultMessage` and from there, through `i18n:extract`, into the generated `en.json`.
- The Italian copy approved in the mockups before they turned English is not thrown away: the last commit with Italian mockups is recorded in `docs/ux/README.md` (`git show <sha>:docs/ux/mockups/<file>`), and its terms are in the translation glossary (`packages/i18n/glossary.md`). No Italian copies of the mockups are kept.

### Four required translations

- Italian, German, Spanish and French are required. `packages/i18n` exports one list of shipped locales; each language joins it when its catalog is first complete (German, Spanish and French in #624, #625 and #626). From then on CI fails if a shipped catalog misses a key, keeps a stale one, changes an ICU argument, or lacks the `other` branch of a plural or select (`pnpm --filter @envelope/i18n check`).
- **Form of address:** the informal one, matching the Italian "tu" the app already uses: Italian *tu*, German *du*, Spanish *tú*, French *tu*. The glossary records it with the terms and the tone notes of each language.

### A translator agent

- A `translator` role agent (`.claude/agents/translator.md`) writes the translations on the developer's branch, after the developer and before the reviews, whenever the branch changes `en.json`. It follows the glossary, and it re-translates every key whose English text changed (`git diff origin/main...HEAD -- packages/i18n/locales/en.json`), not only the new ones.
- For a screen whose mockup was approved in Italian before this ADR, the approved Italian (at the commit recorded in `docs/ux/README.md`) is the source for `it.json`, not a fresh translation of the English.
- An automated check for translations made from an English text that has since changed is optional (#623); until it exists, the translator's discipline above is the safeguard.

### Review status of each language

- Italian is reviewed by the maintainer.
- German, Spanish and French are machine-translated and agent-reviewed. The documentation and the catalog index (`packages/i18n`'s README) say so; the app does not.

### Loading

- Catalogs are loaded per language, on demand, before the first render; English uses the `defaultMessage`s and has no runtime catalog. Every catalog is precached by the service worker, so every language works offline.

### Formatting and currencies

- Rules about currencies (minor-unit exponents, rounding) stay in `packages/core` (ADR 0002). Locale formatting of numbers, amounts and dates goes through `Intl` only and is tested there, for every shipped locale.

### Shipped locales and negotiation

- The shipped locales are a data file in `packages/i18n`, `locales/index.json`, read by the apps, the API and the identity-provider bootstrap alike.
- Language negotiation is a pure function there, `resolveLanguage`, shared by the web and the mobile app (#633). One `en.json` is extracted from every app.

### Interface language and formatting locale

- The interface language and the formatting locale are resolved separately. The default for both is **Automatic** (a null stored value): the language comes from the device, the formatting locale from the device's full regional tag (for example `de-CH`). The user can choose either explicitly.
- Choices are stored on the account; Automatic is resolved per device.
- Plural rules follow the interface language, never the formatting locale.
- How languages are labelled in the selectors is decided with the preferences mockup (#627).

### User preferences

- User preferences (language, format, personal time zone, theme) are user-level data, read and written through `/me/preferences` (#628), cached on each device, and kept outside the workspace sync protocol.
- A change made offline applies locally at once and is sent when the device is back online; the server keeps the latest change by its client timestamp.

### Sign-in and the identity provider

- The sign-in screen has a language selector (#627, #630); that choice belongs to the device. After sign-in, an explicit account language wins; otherwise the device choice counts as the device language.
- The interface language reaches the identity provider through the standard OpenID Connect `ui_locales` parameter, and the identity provider's own translations are used (#631). A custom theme's message bundles, if one is ever added, fall under the translator like the app's catalogs.
- From milestone 0.7.0 the app also writes the identity provider user's `locale` attribute, and the identity provider's emails are translated (#632).

### Push notifications

- Push notifications are composed per device (#629): in the account's explicit language, else in the device's language, else in English. A language the server has no translation for falls back to English.

## Consequences

- Adding a language means: a catalog, a glossary column, a translator run, a UX pass in that language (German, the longest, at 360 px), and adding it to the shipped list.
- Every pull request that changes interface text gets one more agent step. The developer's green checks no longer include catalog completeness; the translator's do.
- The reference screenshots taken from the mockups become English, like the ones taken from the app.
- Translations in languages the maintainer cannot read may contain errors that only users will notice; the documentation invites corrections.
- Until milestone 0.7.0 (#632), the identity provider's own language choice, and its emails once SMTP is configured, are not kept in step with the app's language.
- Branches started before this ADR, whose developer was told to write Italian, keep doing so; the translator then only adds the other languages and re-checks the Italian against the glossary.
