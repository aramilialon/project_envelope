import { formatMoney } from "@envelope/core";
import { useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import type { BudgetMonthCategory } from "../budget/api.ts";
import { runQuickAssign } from "./api.ts";
import TargetEditor from "./TargetEditor.tsx";
import { useTargets } from "./useTargets.ts";
import "./TargetsPanel.css";

const KIND_LABEL: Record<string, string> = {
  monthly: "Monthly amount",
  by_date: "Amount by a date",
  repeating: "Repeating expense",
  balance: "Balance to keep",
};

interface Props {
  readonly workspaceId: string;
  readonly month: string;
  readonly categories: readonly BudgetMonthCategory[];
  readonly currency: string;
  onClose(): void;
  /** Called after a target is added, changed, removed, or "Fund all targets" runs — the budget month needs refetching. */
  onChanged(): void;
}

/**
 * The "Targets" panel (#55, design.md's "Targets"): every target grouped by kind, what each
 * asks this month and what is still missing, "Fund all targets", and the categories without a
 * target yet, each with "+ Add". Opens `TargetEditor` for one category in place of this list;
 * closing the editor (Save, Cancel or Remove) comes back here rather than all the way out,
 * matching the mockup's own nested navigation.
 */
export default function TargetsPanel({ workspaceId, month, categories, currency, onClose, onChanged }: Props) {
  const intl = useIntl();
  const auth = useAuth();
  const categoryIds = categories.map((c) => c.categoryId);
  const targets = useTargets(workspaceId, month, categoryIds);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fundingAll, setFundingAll] = useState(false);

  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency });

  if (editingId) {
    const category = categories.find((c) => c.categoryId === editingId);
    if (!category) {
      return null;
    }
    const existing = targets.status === "ok" ? targets.progressByCategory.get(editingId)?.goal : undefined;
    return (
      <TargetEditor
        workspaceId={workspaceId}
        categoryId={category.categoryId}
        categoryName={category.name}
        month={month}
        currency={currency}
        state={{ carried: category.carriedOver, assigned: category.assigned, available: category.available }}
        {...(existing ? { existing } : {})}
        onClose={() => setEditingId(null)}
        onSaved={() => {
          setEditingId(null);
          targets.refetch();
          onChanged();
        }}
      />
    );
  }

  async function handleFundAll() {
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    setFundingAll(true);
    try {
      await runQuickAssign(accessToken, workspaceId, month, { kind: "all" }, "fund_targets");
      targets.refetch();
      onChanged();
    } finally {
      setFundingAll(false);
    }
  }

  if (targets.status === "loading") {
    return (
      <div className="side-sheet targets-panel" role="dialog" aria-modal="true">
        <p role="status">{intl.formatMessage({ id: "targets.loading", defaultMessage: "Loading your targets…" })}</p>
      </div>
    );
  }

  if (targets.status === "error") {
    return (
      <div className="side-sheet targets-panel" role="dialog" aria-modal="true">
        <p role="alert">{intl.formatMessage({ id: "targets.error", defaultMessage: "We could not load your targets." })}</p>
      </div>
    );
  }

  const withTarget = categories.filter((c) => targets.progressByCategory.has(c.categoryId));
  const withoutTarget = categories.filter((c) => !targets.progressByCategory.has(c.categoryId));
  const byKind = new Map<string, BudgetMonthCategory[]>();
  for (const category of withTarget) {
    const kind = targets.progressByCategory.get(category.categoryId)!.goal.kind;
    const list = byKind.get(kind);
    if (list) {
      list.push(category);
    } else {
      byKind.set(kind, [category]);
    }
  }

  return (
    <div className="side-sheet targets-panel" role="dialog" aria-modal="true" aria-label={intl.formatMessage({ id: "targets.title", defaultMessage: "Targets" })}>
      <div className="panel-head">
        <h2>{intl.formatMessage({ id: "targets.title", defaultMessage: "Targets" })}</h2>
        <button type="button" className="plain" onClick={onClose}>
          {intl.formatMessage({ id: "common.action.close", defaultMessage: "× Close" })}
        </button>
      </div>

      {withTarget.length > 0 && (
        <button type="button" className="btn primary" disabled={fundingAll} onClick={() => void handleFundAll()}>
          {intl.formatMessage({ id: "targets.fundAll", defaultMessage: "Fund all targets" })}
        </button>
      )}

      {[...byKind.entries()].map(([kind, kindCategories]) => (
        <div className="sec" key={kind}>
          <h5>{KIND_LABEL[kind] ?? kind}</h5>
          <ul className="target-list">
            {kindCategories.map((category) => {
              const progress = targets.progressByCategory.get(category.categoryId)!;
              return (
                <li key={category.categoryId}>
                  <button type="button" className="goal-row" onClick={() => setEditingId(category.categoryId)}>
                    <span>
                      <b>{category.name}</b>
                      <small>
                        {intl.formatMessage(
                          { id: "targets.row.status", defaultMessage: "Asks {asks}, {missing} missing" },
                          { asks: money(progress.asks), missing: money(progress.missing) },
                        )}
                      </small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {withoutTarget.length > 0 && (
        <div className="sec">
          <h5>{intl.formatMessage({ id: "targets.withoutTarget", defaultMessage: "No target yet" })}</h5>
          <ul className="target-list">
            {withoutTarget.map((category) => (
              <li key={category.categoryId}>
                <span className="name">{category.name}</span>
                <button type="button" className="plain" onClick={() => setEditingId(category.categoryId)}>
                  {intl.formatMessage({ id: "targets.add", defaultMessage: "+ Add" })}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
