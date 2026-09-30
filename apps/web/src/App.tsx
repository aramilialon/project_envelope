import { useEffect, useState } from "react";

import { checkHealth, type HealthStatus } from "./api.ts";
import "./App.css";

type ConnectionState = "checking" | HealthStatus;

export default function App() {
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
    </main>
  );
}
