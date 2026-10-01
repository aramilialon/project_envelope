# apps/web

The web app: a Vite + React PWA that talks to `apps/api` over a real HTTP connection. Step 1, the installable shell (`#48`); step 2, sign-in (`#49`): Authorization Code + PKCE against Keycloak through `react-oidc-context`/`oidc-client-ts`, session handling (the user's own storage, refreshed automatically) and sign-out; step 3, the workspace switcher (`#50`): `react-router-dom`, `/` picks a workspace (skipped straight through when there is only one) and `/:workspaceId` is everything after; step 4, the persistent sidebar and the accounts screen (`#51`): `AppLayout` wraps every screen under `/:workspaceId` with the sidebar `docs/ux/README.md`'s navigation structure describes (primary navigation, the account ledger, "+ Add account"), and `/accounts` lists, creates and closes an account; step 5, categories and groups (`#52`): `/settings/categories`, reached from the workspace switcher's "Workspace settings", lists every group and its categories, creates, archives and reorders both. The Budget screen itself is still only a placeholder — it starts for real at `#53`.

## Contents

| Path | Contents |
| --- | --- |
| `src/api.ts` | `checkHealth()`: the one unauthenticated API call this skeleton makes, to `GET /health` |
| `src/App.tsx` | Renders `SignIn` while not authenticated; otherwise the router: `/` is `WorkspaceGate`, `/:workspaceId` is `AppLayout`, nesting `Home` (index), `AccountsScreen` (`/accounts`) and `CategoriesScreen` (`/settings/categories`) |
| `src/Home.tsx` | The "/:workspaceId" index route: still just the placeholder for the Budget screen (API connection status) — the real screen starts at `#53` |
| `src/layout/AppLayout.tsx` | The persistent sidebar (`#51`, `docs/ux/README.md`'s "Navigation structure"): the workspace switcher, primary navigation (Budget, Accounts — Portfolio is left out, like `WorkspaceSwitcher`'s own omissions, since it has no screen yet), the account ledger (open accounts, on-budget then off-budget; no balances yet — `apps/api` has no balance endpoint), "+ Add account" (opens `AddAccountForm`), and the user menu (sign-out) |
| `src/accounts/api.ts` | `listAccounts`/`createAccount`/`closeAccount`: `GET`/`POST /workspaces/:workspaceId/accounts`, `PATCH .../:accountId/close` (`#51`) |
| `src/accounts/useAccounts.ts` | `useAccounts(workspaceId)`: fetches a workspace's accounts, with a `refetch` for after a create or a close, shared between `AppLayout`'s own ledger and `AccountsScreen` through `Outlet`'s `context` (no double fetch) |
| `src/accounts/accountType.ts` | `ACCOUNT_TYPE_LABELS`: translated labels for `AccountType`, shared by the list and the creation form |
| `src/accounts/AccountsScreen.tsx` | The "Accounts" screen (`#51`): lists open and closed accounts, closes an open one. Creating one is the sidebar's own job, not duplicated here; reopening a closed one has no endpoint yet |
| `src/accounts/AddAccountForm.tsx` | The sidebar's "+ Add account" side panel (`#51`). No mockup draws this exact form — composed from the onboarding's first-account step and the workspace-settings account list instead, documented in the pull request (`CLAUDE.md`'s "say why") |
| `src/categories/api.ts` | `listCategoryGroups`/`createCategoryGroup`/`reorderCategoryGroups`, the same four for `listCategories`/`createCategory`/`archiveCategory`/`reorderCategories` (`#52`) |
| `src/categories/useCategories.ts` | `useCategories(workspaceId)`: fetches a workspace's groups and categories together, with a `refetch` for after any change |
| `src/categories/CategoriesScreen.tsx` | The "Categories" screen (`#52`), reached from "Workspace settings": every group with its categories, in order; "+ Add a group"/"+ Add a category" (asks for the name upfront — `apps/api` has no rename endpoint, unlike the mockup's edit-in-place), "Archive" (one-way, like `#51`'s account close) and move up/down, composed from `docs/ux/mockups/settings-first-run.html`'s workspace-settings "Categories" tab |
| `src/auth/config.ts` | `oidcConfig`: Authorization Code + PKCE settings for `react-oidc-context`'s `AuthProvider` — authority and client id from `VITE_KEYCLOAK_ISSUER`/`VITE_KEYCLOAK_CLIENT_ID`, the app's own origin as both redirect URIs (no dedicated callback route: `oidc-client-ts` detects a pending `code`/`state` regardless of path), automatic silent renew |
| `src/auth/SignIn.tsx` | The sign-in screen (`#49`, `docs/ux/mockups/sign-in.html`): idle (offer to sign in), pending (mid-redirect) and error, driven by `useAuth()` |
| `src/workspaces/api.ts` | `listMyWorkspaces(accessToken)`: `GET /me/workspaces` — the first *authenticated* API call this app makes (`#50`) |
| `src/workspaces/useWorkspaces.ts` | `useWorkspaces()`: fetches the signed-in user's own workspaces, re-fetching when the access token changes (a silent renew), without flashing back to a loading state while it does |
| `src/workspaces/WorkspaceGate.tsx` | The "/" route (`#50`): none (empty message), one (skips straight through, no pointless extra screen), or several (`WorkspacePicker`) |
| `src/workspaces/WorkspacePicker.tsx` | A full-page list to choose from, shown only when there is more than one workspace |
| `src/workspaces/WorkspaceSwitcher.tsx` | The sidebar's own switcher (`#50`, `docs/ux/mockups/settings-first-run.html`): current workspace's name, a popover listing every one (✓ on the current), and "Workspace settings" (`#52`: goes straight to `/settings/categories`, the only settings section that exists so far). "+ New workspace", also drawn in that mockup, stays left out — it still has no screen |
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

`e2e/sign-in.spec.ts`, `e2e/workspaces.spec.ts`, `e2e/accounts.spec.ts` and `e2e/categories.spec.ts` cover sign-in, sign-out, the workspace switcher, accounts and categories end to end; the first caught `#308` (the Keycloak client's `webOrigins` silently breaking the token exchange's CORS in every real browser), `e2e/accounts.spec.ts` caught `#315` (`@fastify/cors`'s own default `methods` is `GET,HEAD,POST`, not every verb the API uses, so closing an account — the first PATCH call this app makes — failed silently in a real browser while every mocked unit test and `.inject()`-based integration test stayed green) — fixed in `apps/api/src/app.ts`. Not wired into CI yet (`e2e/README.md`): `#63`'s own end-to-end coverage grows from here as later screens land.

The sidebar's account ledger shows every open account's name but not its balance: `apps/api` has no endpoint to compute one yet (that needs transaction aggregation, `#53`/`#54`'s own territory). The "+ Add account" form has no dedicated mockup — composed instead from the onboarding's first-account step and the workspace-settings account list (`docs/ux/mockups/settings-first-run.html`), the closest existing patterns, rather than a new one invented for this screen alone. The categories screen has the same gap: no mockup draws "list, create, archive, reorder" as its own screen, so it is composed from that same mockup's "Categories" settings tab; a newly added group or category cannot be renamed afterward (`apps/api` has no rename endpoint), and archiving either has no undo. No real Budget screen beyond the placeholder yet (`#53` onward). `react-intl` is wired in (`IntlProvider` at the root), but only `locale="en"` exists so far: every string is its own `defaultMessage`, with no Italian catalog or locale negotiation yet (`#62`). The sign-in screen's own error state shows the generic `signIn.error.generic` message plus the raw, untranslated `Error.message` from `oidc-client-ts` as its technical detail — deliberately simpler than `docs/ux/mockups/sign-in.html`'s illustrative `invalid_state` example, since the library does not expose a small, stable set of error codes to translate individually (`docs/ux/README.md` updated to match). The PWA manifest uses a single SVG icon; proper multi-resolution icons are a visual-design follow-up, not a blocker for an installable shell.
