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

### Push notifications

- The budget alert's text is composed server-side from a small English/Italian lookup in `apps/api` (design document, "Notifications"). For German, Spanish and French it falls back to English until there is a per-user language setting that the server can rely on.

## Consequences

- Adding a language means: a catalog, a glossary column, a translator run, a UX pass in that language (German, the longest, at 360 px), and adding it to the shipped list.
- Every pull request that changes interface text gets one more agent step. The developer's green checks no longer include catalog completeness; the translator's do.
- The reference screenshots taken from the mockups become English, like the ones taken from the app.
- Translations in languages the maintainer cannot read may contain errors that only users will notice; the documentation invites corrections.
- Branches started before this ADR, whose developer was told to write Italian, keep doing so; the translator then only adds the other languages and re-checks the Italian against the glossary.
