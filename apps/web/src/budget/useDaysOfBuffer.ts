import { useAuth } from "react-oidc-context";

import { useFetchState, type FetchState } from "../useFetchState.ts";
import { getDaysOfBuffer } from "./api.ts";

export type DaysOfBufferState = FetchState<{ daysOfBuffer: number }>;

/** Fetches the workspace's own days of buffer (#344) once per workspace. */
export function useDaysOfBuffer(workspaceId: string): DaysOfBufferState {
  const auth = useAuth();
  const accessToken = auth.user?.access_token;
  const state = useFetchState(
    () => (accessToken ? getDaysOfBuffer(accessToken, workspaceId).then(({ daysOfBuffer }) => ({ daysOfBuffer })) : undefined),
    [accessToken, workspaceId],
  );
  // No `refetch` here: nothing calls it, so the type stays exactly what it was before `useFetchState` existed.
  return state.status === "ok" ? { status: "ok", daysOfBuffer: state.daysOfBuffer } : { status: state.status };
}
