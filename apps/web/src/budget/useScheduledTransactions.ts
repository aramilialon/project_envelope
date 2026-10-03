import { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { listScheduledTransactions, type ScheduledTransaction } from "./api.ts";

export type ScheduledTransactionsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; scheduledTransactions: readonly ScheduledTransaction[] };

/** Every scheduled transaction of the workspace (#330) — `apps/api` has no per-month filter, so the "Scheduled" panel groups this itself by `nextDueDate`. */
export function useScheduledTransactions(workspaceId: string): ScheduledTransactionsState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const [state, setState] = useState<ScheduledTransactionsState>({ status: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    let cancelled = false;
    listScheduledTransactions(accessToken, workspaceId)
      .then((scheduledTransactions) => {
        if (!cancelled) {
          setState({ status: "ok", scheduledTransactions });
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
  }, [accessToken, workspaceId, generation]);

  const refetch = () => setGeneration((g) => g + 1);

  return { ...state, refetch };
}
