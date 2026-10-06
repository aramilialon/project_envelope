import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import CenteredCard from "../layout/CenteredCard.tsx";
import "./SignIn.css";

/**
 * Sign-in (#49, docs/ux/mockups/sign-in.html): the app owns no credentials of its own, so this
 * is a redirect, not a login form — idle (offer to sign in), pending (mid-redirect) and error,
 * driven entirely by `react-oidc-context`'s `useAuth()`. Rendered by `App.tsx` whenever
 * `auth.isAuthenticated` is false. The mockup's own "A problem? Write to your server's admin"
 * footer is left out — the app has no admin-contact destination to send it to yet.
 */
export default function SignIn() {
  const auth = useAuth();
  const intl = useIntl();

  if (auth.error) {
    return (
      <CenteredCard>
        <p className="mark" aria-hidden="true">
          envelope
        </p>
        <div className="err" role="alert">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M12 2 1 21h22L12 2Zm0 6 7 12H5l7-12Zm-1 4h2v5h-2v-5Zm0 6h2v2h-2v-2Z" />
          </svg>
          <p>
            {intl.formatMessage({ id: "signIn.error.generic", defaultMessage: "We could not complete sign-in." })}
            <span className="code">{auth.error.message}</span>
          </p>
        </div>
        <button type="button" className="primary" onClick={() => void auth.signinRedirect()}>
          {intl.formatMessage({ id: "signIn.retry", defaultMessage: "Retry" })}
        </button>
      </CenteredCard>
    );
  }

  if (auth.isLoading) {
    return (
      <CenteredCard>
        <p className="mark" aria-hidden="true">
          envelope
        </p>
        <p className="tag">
          {intl.formatMessage({ id: "signIn.pending.tagline", defaultMessage: "Redirecting…" })}
        </p>
        <button type="button" className="primary" disabled aria-busy="true">
          <span className="spin" aria-hidden="true" />
          {intl.formatMessage({ id: "signIn.pending.action", defaultMessage: "Signing in" })}
        </button>
        <p className="sr-only" role="status">
          {intl.formatMessage({
            id: "signIn.pending.status",
            defaultMessage: "Redirecting to the sign-in page",
          })}
        </p>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <p className="mark" aria-hidden="true">
        envelope
      </p>
      <p className="tag">
        {intl.formatMessage({ id: "signIn.tagline", defaultMessage: "Budget and portfolio, on your own server." })}
      </p>
      <button type="button" className="primary" onClick={() => void auth.signinRedirect()}>
        {intl.formatMessage({ id: "signIn.action", defaultMessage: "Sign in" })}
      </button>
    </CenteredCard>
  );
}
