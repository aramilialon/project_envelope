import { useEffect, useState } from "react";

import { checkHealth, type HealthStatus } from "./api.ts";
import "./App.css";

type ConnectionState = "checking" | HealthStatus;

/** The "/:workspaceId" index route: still just the Budget placeholder (the real screen starts at #53). */
export default function Home() {
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
    <p className={`status status-${state}`} role="status">
      {state === "checking" && "Checking the API…"}
      {state === "ok" && "Connected to the API."}
      {state === "error" && "Could not reach the API."}
    </p>
  );
}
