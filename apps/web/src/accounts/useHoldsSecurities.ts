import { useEffect, useState } from "react";

import { holdsSecurities, type Account } from "./api.ts";

/**
 * Whether any of `accounts` holds securities (#652), for the accounts panel's line saying the net
 * worth does not include them until prices exist (#125). Only a brokerage account can have trades
 * (the API refuses them elsewhere, `account_not_brokerage`), so only those are asked: one read of
 * the existing positions endpoint each, run in parallel, as `useAccountBalances` reads each
 * account's transactions — a household has few brokerage accounts, and no other endpoint says
 * this. False while loading or when a read fails: the line is then left out rather than shown
 * wrongly. A change of `refreshKey` reads them again.
 */
export function useHoldsSecurities(
  workspaceId: string,
  accessToken: string | undefined,
  accounts: readonly Account[],
  refreshKey = "",
): boolean {
  const [holds, setHolds] = useState(false);
  const brokerageIds = accounts
    .filter((a) => a.type === "brokerage")
    .map((a) => a.id)
    .join(",");

  useEffect(() => {
    if (!accessToken || brokerageIds === "") {
      return;
    }
    let cancelled = false;
    Promise.all(brokerageIds.split(",").map((accountId) => holdsSecurities(accessToken, workspaceId, accountId)))
      .then((results) => {
        if (!cancelled) {
          setHolds(results.some(Boolean));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHolds(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, accessToken, brokerageIds, refreshKey]);

  // With no brokerage account left open, an earlier answer no longer applies.
  return brokerageIds !== "" && holds;
}
