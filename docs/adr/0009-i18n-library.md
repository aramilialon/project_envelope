# 0009 — FormatJS for the web app's i18n library

- **Status:** accepted
- **Date:** 2026-09-30

## Context

ADR 0004 already decided the shape of the solution: every user-facing string comes from a catalog, looked up by a stable, dot-namespaced key (`budget.unassigned.title`); messages use ICU MessageFormat for plurals and variables; catalogs are one JSON file per language in the repository; a CI check fails if a required language is missing a key. ADR 0004 named three candidates, all supporting React and React Native: i18next, FormatJS and Lingui. This ADR picks one, for the web app first (0.1.7) and the mobile app later (0.3.x), which will share the same catalogs and keys.

## Decision

**FormatJS** (`react-intl` for the web app, `@formatjs/intl` for anything outside a component).

- ICU MessageFormat is FormatJS's own native message format, not a plugin bolted onto a different default syntax — it is, along with Lingui, the most complete ICU implementation of the three, and needs no extra dependency to get there.
- Its idiom is **key + default message** (`intl.formatMessage({ id: "budget.unassigned.title", defaultMessage: "..." })`), matching ADR 0004's stable-key lookup directly. Lingui's own idiom is the opposite: it extracts the *source-language text itself* from `t\`...\`` template literals as the primary identifier, with an explicit id as an opt-out rather than the default — swimming against a convention this project already settled.
- `@formatjs/cli` extracts every `id`/`defaultMessage` pair from the source and compiles each language's catalog against it, exactly the "a CI check fails if a key is missing" ADR 0004 asks for, as first-party tooling rather than a community plugin (i18next's own ICU support, `i18next-icu`, is one such plugin, not the default).
- React Native is supported (confirmed as of September 2026): the same `IntlProvider`/`formatMessage` API works there once the platform's own `Intl` polyfills are in place, so the mobile app (0.3.x) reuses the same catalogs and keys without a second i18n library to keep in sync.

## Discarded alternatives

- **i18next / react-i18next.** The most popular of the three and the lightest by default, but ICU MessageFormat is an add-on (`i18next-icu`) over its own native interpolation and pluralization syntax, not the format it is built around — every message would carry a plugin dependency ADR 0004's own examples do not need.
- **Lingui.** Ties with FormatJS on ICU completeness and has the smallest runtime and the strongest compile-time type safety of the three (its macros generate types from the catalogs themselves). Discarded only because its default workflow keys a message by its own source text, not a stable id like `budget.unassigned.title` — usable against the grain, but FormatJS's own idiom is that convention already, with no workaround needed.

## Consequences

- `apps/web` depends on `react-intl`; `packages/core` still never imports it or produces any user-facing text (ADR 0004) — the core stays the same regardless of which i18n library the apps use.
- The heavier of the three runtimes (roughly 20 kB minified and gzipped, against i18next's ~9 kB and Lingui's ~10 kB): accepted, since this is a self-hosted personal/family app, not a public product where every kilobyte of a CDN bill matters.
- `@formatjs/cli`'s extraction becomes the source of truth for which keys exist; the English catalog is generated from the code's own `defaultMessage`s, and only the Italian (and any later language's) catalog is hand-translated and CI-checked for completeness against it.
