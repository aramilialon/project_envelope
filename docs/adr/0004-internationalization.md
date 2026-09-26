# 0004 — English source, translatable UI, locale-aware formatting

- **Status:** accepted
- **Date:** 2026-09-25

## Context

The project may become open source and be used outside Italy. The main user is Italian and wants the interface in Italian.

## Decision

### Languages

- Code, comments, documentation, commit messages and issue titles are in **English**.
- The user interface is **translatable**. English is the source language; Italian is the first translation and must always be complete.

### No hard-coded text

- Every user-facing string in the apps comes from a translation catalog, looked up by a stable key (for example `budget.unassigned.title`).
- Messages use the **ICU MessageFormat** syntax, which handles plurals and variables correctly in every language (for example `{count, plural, one {# category} other {# categories}}`).
- Catalogs live in the repository, one file per language (for example `packages/i18n/locales/en.json` and `it.json`). A CI check fails if a key is missing in a required language.
- The i18n library (candidates: i18next, FormatJS, Lingui, all of which support React and React Native) will be chosen in phase 1 with its own ADR.

### The core stays language-neutral

- `packages/core` never produces sentences for users. It returns data and errors with a stable `code` and `details` (see `ValidationError`); the UI turns them into translated messages.

### Locale-aware formatting

- Numbers, amounts, dates and months are formatted with the standard `Intl` API in the user's locale: `formatMoney` and `parseAmount` in the core already work this way.
- Three separate user settings: **language** of the interface, **locale** for number and date formats, **time zone**. Currency is a property of each account and of the workspace, not of the user.

## Consequences

- Adding a language means adding a catalog file, without touching the code.
- Every new screen costs a little more (keys instead of plain strings), in exchange for never having to extract text later.
- Error messages in logs stay in English, readable by any developer.
