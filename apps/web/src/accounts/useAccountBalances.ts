import { useEffect, useState } from "react";

import { listTransactionsForAccount } from "../transactions/api.ts";
import { totalOf } from "../transactions/transactionAmount.ts";
import type { Account } from "./api.ts";

export type AccountBalances = Readonly<Record<string, number>>;

/**
 * Each open account's own balance (#333): the same sum the register computes for its own total,
 * one fetch per account run in parallel. There is no bulk endpoint, and no reason for one yet —
 * a household's own account count is small.
 */
export function useAccountBalances(workspaceId: string, accessToken: string | undefined, accounts: readonly Account[]): AccountBalances {
  const [balances, setBalances] = useState<AccountBalances>({});
  const accountIds = accounts.map((a) => a.id).join(",");

  useEffect(() => {
    if (!accessToken || accountIds === "") {
      return;
    }
    let cancelled = false;
    Promise.all(
      accountIds.split(",").map(async (accountId) => {
        const transactions = await listTransactionsForAccount(accessToken, workspaceId, accountId);
        return [accountId, transactions.reduce((sum, t) => sum + totalOf(t), 0)] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) {
          setBalances(Object.fromEntries(entries));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBalances({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, accessToken, accountIds]);

  return balances;
}
