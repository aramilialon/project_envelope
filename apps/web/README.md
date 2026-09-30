# apps/web

The web app: a Vite + React PWA that talks to `apps/api` over a real HTTP connection, nothing more yet. Step 1 of the frontend work (see `CLAUDE.md`): an installable shell, connected to the API, with only a placeholder screen (`#48`).

## Contents

| Path | Contents |
| --- | --- |
| `src/api.ts` | `checkHealth()`: the one API call this skeleton makes, to `GET /health` |
| `src/App.tsx` | The placeholder screen: the wordmark and the API connection status |
| `src/main.tsx` | Entry point: mounts `<App />` |
| `src/vite-env.d.ts` | Types `import.meta.env.VITE_API_URL` |
| `src/test-setup.ts` | Vitest's own setup: `@testing-library/jest-dom` matchers, RTL's `cleanup` after every test (not automatic under Vitest, unlike Jest) |
| `*.test.tsx` | Tests, next to the component they check (Vitest + React Testing Library) |
| `vite.config.ts` | The dev server, the build, the PWA manifest (`vite-plugin-pwa`) and Vitest's own config, all in one file |

## Commands

```bash
pnpm --filter @envelope/web dev         # dev server with HMR
pnpm --filter @envelope/web build       # typecheck, then production build
pnpm --filter @envelope/web test        # Vitest
pnpm --filter @envelope/web typecheck   # tsc -b, no emit
pnpm --filter @envelope/web lint        # oxlint
```

## Configuration

Copy `.env.example` to `.env`. Vite only exposes variables prefixed `VITE_` to client code.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_API_URL` | — (required) | Where `apps/api` runs, e.g. `http://127.0.0.1:3000` |

The API's own CORS policy (`WEB_ORIGIN`, `apps/api/.env.example`) must allow this app's origin — `http://localhost:5173`, Vite's own dev server port, is already the default on both sides.

## Design

Screens follow [`docs/design.md`, "User interface"](../../docs/design.md#user-interface) and [`docs/ux/README.md`](../../docs/ux/README.md) (screen inventory, navigation, component catalog, accessibility baseline); a screen without a mockup in `docs/ux/mockups/` is not built from scratch (`CLAUDE.md`). The colour tokens in `src/index.css` are copied from there; no other colours. Text is self-hosted, not loaded from Google Fonts (unlike the mockups themselves) — not added yet, since no real screen needs the Archivo type family yet.

## Current limitations

No routing, no sign-in, no i18n catalog (FormatJS, ADR 0009) and no real screen beyond the placeholder yet — all of `#49` onward. The PWA manifest uses a single SVG icon; proper multi-resolution icons are a visual-design follow-up, not a blocker for an installable shell.
