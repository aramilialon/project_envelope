import { useAuth } from "react-oidc-context";

import { useFetchState, type FetchState } from "../useFetchState.ts";
import { listScheduledTransactions, type ScheduledTransaction } from "./api.ts";

export type ScheduledTransactionsState = FetchState<{ scheduledTransactions: readonly ScheduledTransaction[] }>;

/** Every scheduled transaction of the workspace (#330) — `apps/api` has no per-month filter, so the "Scheduled" panel groups this itself by `nextDueDate`. */
export function useScheduledTransactions(workspaceId: string): ScheduledTransactionsState & { refetch(): void } {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  return useFetchState(
    () => (accessToken ? listScheduledTransactions(accessToken, workspaceId).then((scheduledTransactions) => ({ scheduledTransactions })) : undefined),
    [accessToken, workspaceId],
  );
}
