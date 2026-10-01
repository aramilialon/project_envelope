# apps/web

The web app: a Vite + React PWA that talks to `apps/api` over a real HTTP connection. Step 1, the installable shell (`#48`); step 2, sign-in (`#49`): Authorization Code + PKCE against Keycloak through `react-oidc-context`/`oidc-client-ts`, session handling (the user's own storage, refreshed automatically) and sign-out; step 3, the workspace switcher (`#50`): `react-router-dom`, `/` picks a workspace (skipped straight through when there is only one) and `/:workspaceId` is everything after. Still only a placeholder screen once a workspace is chosen — the real budget screens start at `#53`.

## Contents

| Path | Contents |
| --- | --- |
| `src/api.ts` | `checkHealth()`: the one unauthenticated API call this skeleton makes, to `GET /health` |
| `src/App.tsx` | Renders `SignIn` while not authenticated; otherwise the router: `/` is `WorkspaceGate`, `/:workspaceId` is `Home` |
| `src/Home.tsx` | The "/:workspaceId" route: still just the placeholder screen (wordmark, API connection status, sign-out), now with the workspace switcher (`#50`) |
| `src/auth/config.ts` | `oidcConfig`: Authorization Code + PKCE settings for `react-oidc-context`'s `AuthProvider` — authority and client id from `VITE_KEYCLOAK_ISSUER`/`VITE_KEYCLOAK_CLIENT_ID`, the app's own origin as both redirect URIs (no dedicated callback route: `oidc-client-ts` detects a pending `code`/`state` regardless of path), automatic silent renew |
| `src/auth/SignIn.tsx` | The sign-in screen (`#49`, `docs/ux/mockups/sign-in.html`): idle (offer to sign in), pending (mid-redirect) and error, driven by `useAuth()` |
| `src/workspaces/api.ts` | `listMyWorkspaces(accessToken)`: `GET /me/workspaces` — the first *authenticated* API call this app makes (`#50`) |
| `src/workspaces/useWorkspaces.ts` | `useWorkspaces()`: fetches the signed-in user's own workspaces, re-fetching when the access token changes (a silent renew), without flashing back to a loading state while it does |
| `src/workspaces/WorkspaceGate.tsx` | The "/" route (`#50`): none (empty message), one (skips straight through, no pointless extra screen), or several (`WorkspacePicker`) |
| `src/workspaces/WorkspacePicker.tsx` | A full-page list to choose from, shown only when there is more than one workspace |
| `src/workspaces/WorkspaceSwitcher.tsx` | The sidebar's own switcher (`#50`, `docs/ux/mockups/settings-first-run.html`): current workspace's name, a popover listing every one (✓ on the current). "Workspace settings" and "+ New workspace", also drawn in that mockup, are left out — neither feature exists yet |
| `src/main.tsx` | Entry point: wraps `<App />` in `IntlProvider` (`locale="en"` until `#62` adds the Italian catalog), `AuthProvider` and `BrowserRouter`, then mounts it |
| `src/vite-env.d.ts` | Types `import.meta.env`: `VITE_API_URL`, `VITE_KEYCLOAK_ISSUER`, `VITE_KEYCLOAK_CLIENT_ID` |
| `src/test-utils.tsx` | `renderWithIntl`: wraps a component in `IntlProvider` for tests — every component using `react-intl` needs it |
| `src/test-setup.ts` | Vitest's own setup: `@testing-library/jest-dom` matchers, RTL's `cleanup` after every test (not automatic under Vitest, unlike Jest) |
| `*.test.tsx` | Unit tests, next to the component they check (Vitest + React Testing Library); `react-oidc-context`'s `useAuth` is mocked here — the real round trip is `e2e/`'s job |
| `vite.config.ts` | The dev server, the build, the PWA manifest (`vite-plugin-pwa`) and Vitest's own config (`test.include` excludes `e2e/`, Playwright's own), all in one file |
| `playwright.config.ts` | End-to-end config: starts `pnpm dev` for the run, headless Chromium only |
| `e2e/` | End-to-end tests (Playwright), against a real Keycloak and `apps/api` — see `e2e/README.md` |

## Commands

```bash
pnpm --filter @envelope/web dev         # dev server with HMR
pnpm --filter @envelope/web build       # typecheck, then production build
pnpm --filter @envelope/web test        # Vitest
pnpm --filter @envelope/web test:e2e    # Playwright, against a real Keycloak and apps/api (e2e/README.md)
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

`e2e/sign-in.spec.ts` and `e2e/workspaces.spec.ts` cover sign-in, sign-out and the workspace switcher end to end; the former is what caught `#308` (the Keycloak client's `webOrigins` silently breaking the token exchange's CORS in every real browser, something a mocked `useAuth()` unit test cannot see) — fixed in `scripts/keycloak/bootstrap.sh`. Not wired into CI yet (`e2e/README.md`): `#63`'s own end-to-end coverage grows from here as later screens land.

No real screen beyond the placeholder yet (`#53` onward). `react-intl` is wired in (`IntlProvider` at the root), but only `locale="en"` exists so far: every string is its own `defaultMessage`, with no Italian catalog or locale negotiation yet (`#62`). The sign-in screen's own error state shows the generic `signIn.error.generic` message plus the raw, untranslated `Error.message` from `oidc-client-ts` as its technical detail — deliberately simpler than `docs/ux/mockups/sign-in.html`'s illustrative `invalid_state` example, since the library does not expose a small, stable set of error codes to translate individually (`docs/ux/README.md` updated to match). The PWA manifest uses a single SVG icon; proper multi-resolution icons are a visual-design follow-up, not a blocker for an installable shell.
