import { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { getDaysOfBuffer } from "./api.ts";

export type DaysOfBufferState = { status: "loading" } | { status: "error" } | { status: "ok"; daysOfBuffer: number };

/** Fetches the workspace's own days of buffer (#344) once per workspace. */
export function useDaysOfBuffer(workspaceId: string): DaysOfBufferState {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const [state, setState] = useState<DaysOfBufferState>({ status: "loading" });

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    let cancelled = false;
    getDaysOfBuffer(accessToken, workspaceId)
      .then(({ daysOfBuffer }) => {
        if (!cancelled) {
          setState({ status: "ok", daysOfBuffer });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, workspaceId]);

  return state;
}
