# apps/web

The web app: a Vite + React PWA that talks to `apps/api` over a real HTTP connection. Step 1, the installable shell (`#48`); step 2, sign-in (`#49`): Authorization Code + PKCE against Keycloak through `react-oidc-context`/`oidc-client-ts`, session handling (the user's own storage, refreshed automatically) and sign-out. Still only a placeholder screen once signed in — the real budget screens start at `#53`.

## Contents

| Path | Contents |
| --- | --- |
| `src/api.ts` | `checkHealth()`: the one API call this skeleton makes, to `GET /health` |
| `src/App.tsx` | Renders `SignIn` while not authenticated, otherwise the placeholder screen (wordmark, API connection status, sign-out) |
| `src/auth/config.ts` | `oidcConfig`: Authorization Code + PKCE settings for `react-oidc-context`'s `AuthProvider` — authority and client id from `VITE_KEYCLOAK_ISSUER`/`VITE_KEYCLOAK_CLIENT_ID`, the app's own origin as both redirect URIs (no router yet, so no dedicated callback route), automatic silent renew |
| `src/auth/SignIn.tsx` | The sign-in screen (`#49`, `docs/ux/mockups/sign-in.html`): idle (offer to sign in), pending (mid-redirect) and error, driven by `useAuth()` |
| `src/main.tsx` | Entry point: wraps `<App />` in `IntlProvider` (`locale="en"` until `#62` adds the Italian catalog) and `AuthProvider`, then mounts it |
| `src/vite-env.d.ts` | Types `import.meta.env`: `VITE_API_URL`, `VITE_KEYCLOAK_ISSUER`, `VITE_KEYCLOAK_CLIENT_ID` |
| `src/test-utils.tsx` | `renderWithIntl`: wraps a component in `IntlProvider` for tests — every component using `react-intl` needs it |
| `src/test-setup.ts` | Vitest's own setup: `@testing-library/jest-dom` matchers, RTL's `cleanup` after every test (not automatic under Vitest, unlike Jest) |
| `*.test.tsx` | Tests, next to the component they check (Vitest + React Testing Library); `react-oidc-context`'s `useAuth` is mocked, not exercised against a real Keycloak (no browser-driven end-to-end test exists yet for this app, `#63`) |
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
| `VITE_KEYCLOAK_ISSUER` | — (required) | The "envelope" realm's issuer URL, e.g. `http://127.0.0.1:8080/realms/envelope` (`scripts/keycloak/bootstrap.sh`) |
| `VITE_KEYCLOAK_CLIENT_ID` | — (required) | The realm's public, PKCE-only client (default `envelope-api`) — the same client `apps/api`'s own `KEYCLOAK_AUDIENCE` names |

The API's own CORS policy (`WEB_ORIGIN`, `apps/api/.env.example`) must allow this app's origin — `http://localhost:5173`, Vite's own dev server port, is already the default on both sides. The Keycloak client's `post.logout.redirect.uris` attribute must include this app's origin too (the bootstrap script sets it to `"+"`, the same as its redirect URIs), or sign-out fails.

## Design

Screens follow [`docs/design.md`, "User interface"](../../docs/design.md#user-interface) and [`docs/ux/README.md`](../../docs/ux/README.md) (screen inventory, navigation, component catalog, accessibility baseline); a screen without a mockup in `docs/ux/mockups/` is not built from scratch (`CLAUDE.md`). The colour tokens in `src/index.css` are copied from there; no other colours. Text is self-hosted, not loaded from Google Fonts (unlike the mockups themselves) — not added yet, since no real screen needs the Archivo type family yet.

## Current limitations

No routing and no real screen beyond the placeholder yet (`#50` onward). `react-intl` is wired in (`IntlProvider` at the root), but only `locale="en"` exists so far: every string is its own `defaultMessage`, with no Italian catalog or locale negotiation yet (`#62`). The sign-in screen's own error state shows the generic `signIn.error.generic` message plus the raw, untranslated `Error.message` from `oidc-client-ts` as its technical detail — deliberately simpler than `docs/ux/mockups/sign-in.html`'s illustrative `invalid_state` example, since the library does not expose a small, stable set of error codes to translate individually (`docs/ux/README.md` updated to match). The PWA manifest uses a single SVG icon; proper multi-resolution icons are a visual-design follow-up, not a blocker for an installable shell.
