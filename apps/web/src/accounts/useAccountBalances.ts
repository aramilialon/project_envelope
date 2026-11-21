import { computeAccountBalance, type BalanceRow } from "@envelope/core";
import { useEffect, useState } from "react";

import { listTransactionsForAccount } from "../transactions/api.ts";
import { balanceRowOf } from "../transactions/transactionAmount.ts";
import { todayIsoIn } from "../workspaceDate.ts";
import type { Account } from "./api.ts";

export type AccountBalances = Readonly<Record<string, number>>;

/**
 * Each account's balance as of today (#333, #702): the same figure the register shows at its
 * head, `computeAccountBalance` over the rows dated on or before today in the workspace's time
 * zone (`timeZone`; the browser's own until the workspace's loads), one fetch per account run in
 * parallel. There is no bulk endpoint, and no reason for one yet — a household's own account
 * count is small. A change of `refreshKey` reads them all again (the accounts panel's own case,
 * `#412`: it stays open across screens and recorded transactions). The rows are kept rather than
 * their sum, so the balances follow the day (and the time zone, once known) without a new fetch:
 * "today" is read again on each render, so a balance moves to the new day on the next render after
 * midnight in the workspace's zone. No timer forces that render; a screen left open past midnight
 * keeps the old day's balances until something re-renders it.
 */
export function useAccountBalances(
  workspaceId: string,
  accessToken: string | undefined,
  accounts: readonly Account[],
  timeZone: string | undefined,
  refreshKey = "",
): AccountBalances {
  const [rowsByAccount, setRowsByAccount] = useState<Readonly<Record<string, readonly BalanceRow[]>>>({});
  const accountIds = accounts.map((a) => a.id).join(",");

  useEffect(() => {
    if (!accessToken || accountIds === "") {
      return;
    }
    let cancelled = false;
    Promise.all(
      accountIds.split(",").map(async (accountId) => {
        const transactions = await listTransactionsForAccount(accessToken, workspaceId, accountId);
        return [accountId, transactions.map(balanceRowOf)] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) {
          setRowsByAccount(Object.fromEntries(entries));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRowsByAccount({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, accessToken, accountIds, refreshKey]);

  const today = todayIsoIn(timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  return Object.fromEntries(Object.entries(rowsByAccount).map(([accountId, rows]) => [accountId, computeAccountBalance(rows, today).balanceCents]));
}
