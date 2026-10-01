import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import { checkHealth, type HealthStatus } from "./api.ts";
import SignIn from "./auth/SignIn.tsx";
import "./App.css";

type ConnectionState = "checking" | HealthStatus;

export default function App() {
  const auth = useAuth();
  const intl = useIntl();
  const [state, setState] = useState<ConnectionState>("checking");

  useEffect(() => {
    let cancelled = false;
    checkHealth().then((status) => {
      if (!cancelled) {
        setState(status);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!auth.isAuthenticated) {
    return <SignIn />;
  }

  return (
    <main className="placeholder">
      <p className="mark" aria-hidden="true">
        envelope
      </p>
      <p className={`status status-${state}`} role="status">
        {state === "checking" && "Checking the API…"}
        {state === "ok" && "Connected to the API."}
        {state === "error" && "Could not reach the API."}
      </p>
      <button type="button" onClick={() => void auth.signoutRedirect()}>
        {intl.formatMessage({ id: "common.action.signOut", defaultMessage: "Sign out" })}
      </button>
    </main>
  );
}
