import type { AuthProviderProps } from "react-oidc-context";

const ISSUER: string = import.meta.env.VITE_KEYCLOAK_ISSUER;
const CLIENT_ID: string = import.meta.env.VITE_KEYCLOAK_CLIENT_ID;

/**
 * Authorization Code + PKCE against Keycloak (design.md, "Authentication with Keycloak"): the
 * app speaks standard OpenID Connect only, so the identity provider stays swappable — nothing
 * here is Keycloak-specific. `redirect_uri`/`post_logout_redirect_uri` are the app's own origin
 * (no dedicated callback route yet: there is no router before #50, and `oidc-client-ts` detects
 * a pending `code`/`state` in the URL regardless of path). `post_logout_redirect_uri` needs the
 * matching `post.logout.redirect.uris` client attribute (`scripts/keycloak/bootstrap.sh`), or
 * Keycloak rejects it outright. `automaticSilentRenew` uses the refresh token directly once one
 * exists, with no iframe involved.
 */
export const oidcConfig: AuthProviderProps = {
  authority: ISSUER,
  client_id: CLIENT_ID,
  redirect_uri: window.location.origin,
  post_logout_redirect_uri: window.location.origin,
  response_type: "code",
  scope: "openid profile email",
  automaticSilentRenew: true,
  onSigninCallback: () => {
    // Drop the ?code=&state= query string once oidc-client-ts has consumed it, so a reload
    // never replays the same authorization code.
    window.history.replaceState({}, document.title, window.location.pathname);
  },
};
