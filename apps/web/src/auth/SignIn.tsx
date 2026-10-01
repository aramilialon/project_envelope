import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import "./SignIn.css";

/**
 * Sign-in (#49, docs/ux/mockups/sign-in.html): the app owns no credentials of its own, so this
 * is a redirect, not a login form — idle (offer to sign in), pending (mid-redirect) and error,
 * driven entirely by `react-oidc-context`'s `useAuth()`. Rendered by `App.tsx` whenever
 * `auth.isAuthenticated` is false.
 */
export default function SignIn() {
  const auth = useAuth();
  const intl = useIntl();

  if (auth.error) {
    return (
      <main className="sign-in-card" aria-live="polite">
        <p className="mark" aria-hidden="true">
          envelope
        </p>
        <div className="err" role="alert">
          <p>
            {intl.formatMessage({ id: "signIn.error.generic", defaultMessage: "We could not complete sign-in." })}
            <span className="code">{auth.error.message}</span>
          </p>
        </div>
        <button type="button" className="primary" onClick={() => void auth.signinRedirect()}>
          {intl.formatMessage({ id: "signIn.retry", defaultMessage: "Retry" })}
        </button>
      </main>
    );
  }

  if (auth.isLoading) {
    return (
      <main className="sign-in-card" aria-live="polite">
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
      </main>
    );
  }

  return (
    <main className="sign-in-card" aria-live="polite">
      <p className="mark" aria-hidden="true">
        envelope
      </p>
      <p className="tag">
        {intl.formatMessage({ id: "signIn.tagline", defaultMessage: "Budget and portfolio, on your own server." })}
      </p>
      <button type="button" className="primary" onClick={() => void auth.signinRedirect()}>
        {intl.formatMessage({ id: "signIn.action", defaultMessage: "Sign in" })}
      </button>
    </main>
  );
}
