import { computeTarget, formatMoney, parseAmount, type CategoryTargetState, type Target } from "@envelope/core";
import { useState, type FormEvent } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";

import SideSheet from "../layout/SideSheet.tsx";
import { deleteGoal, upsertGoal, type GoalKind, type GoalRecord, type RepeatInterval } from "./api.ts";
import "./TargetEditor.css";

const KINDS: readonly { kind: GoalKind; label: string; hint: string }[] = [
  { kind: "monthly", label: "Monthly amount", hint: "Asks the same amount every month." },
  { kind: "by_date", label: "Amount by a date", hint: "Saves up a total by a due month, spread over the months left." },
  { kind: "repeating", label: "Repeating expense", hint: "Like \"amount by a date\", but the due month moves forward once it passes." },
  { kind: "balance", label: "Balance to keep", hint: "Asks enough to keep the category's available amount at or above a threshold." },
];
const INTERVALS: readonly RepeatInterval[] = [2, 3, 4, 6, 12, 24];

interface Props {
  readonly workspaceId: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly month: string;
  readonly state: CategoryTargetState;
  readonly existing?: GoalRecord;
  readonly currency: string;
  onClose(): void;
  onSaved(): void;
}

function targetFrom(kind: GoalKind, amountCents: number, dueMonth: string, every: RepeatInterval): Target | null {
  switch (kind) {
    case "monthly":
      return { kind: "monthly", amount: amountCents };
    case "balance":
      return { kind: "balance", threshold: amountCents };
    case "by_date":
      return dueMonth ? { kind: "by_date", amount: amountCents, dueMonth } : null;
    case "repeating":
      return dueMonth ? { kind: "repeating", amount: amountCents, dueMonth, every } : null;
  }
}

/**
 * The target editor (#55, design.md's "Target editor"): the four kinds, amount, due month and
 * repeat interval where the kind needs them, and a live preview computed client-side with
 * `packages/core`'s own `computeTarget` — no network round trip needed to show it. Reached from
 * the "Targets" panel's own "+ Add"/"Edit" per category.
 */
export default function TargetEditor({ workspaceId, categoryId, categoryName, month, state, existing, currency, onClose, onSaved }: Props) {
  const intl = useIntl();
  const auth = useAuth();
  const [kind, setKind] = useState<GoalKind>(existing?.kind ?? "monthly");
  const [amountStr, setAmountStr] = useState(existing ? (existing.amountCents / 100).toFixed(2) : "");
  const [dueMonth, setDueMonth] = useState(existing?.dueMonth ?? "");
  const [every, setEvery] = useState<RepeatInterval>((existing?.every as RepeatInterval | null) ?? 12);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency });

  let preview: ReturnType<typeof computeTarget> | null = null;
  let previewAmount: number | null = null;
  try {
    previewAmount = amountStr.trim() ? parseAmount(amountStr, { locale: intl.locale, currency }) : null;
    if (previewAmount !== null && previewAmount > 0) {
      const target = targetFrom(kind, previewAmount, dueMonth, every);
      if (target) {
        preview = computeTarget(target, state, month);
      }
    }
  } catch {
    previewAmount = null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    setError(null);
    if (previewAmount === null || previewAmount <= 0) {
      setError(intl.formatMessage({ id: "targets.editor.invalidAmount", defaultMessage: "Enter an amount greater than zero." }));
      return;
    }
    if ((kind === "by_date" || kind === "repeating") && !dueMonth) {
      setError(intl.formatMessage({ id: "targets.editor.needDueMonth", defaultMessage: "Choose a due month." }));
      return;
    }
    setSubmitting(true);
    try {
      await upsertGoal(accessToken, workspaceId, categoryId, {
        kind,
        amountCents: previewAmount,
        ...(kind === "by_date" || kind === "repeating" ? { dueMonth } : {}),
        ...(kind === "repeating" ? { every } : {}),
      });
      onSaved();
    } catch {
      setError(intl.formatMessage({ id: "targets.editor.error", defaultMessage: "We could not save this target." }));
      setSubmitting(false);
    }
  }

  async function handleRemove() {
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    setSubmitting(true);
    try {
      await deleteGoal(accessToken, workspaceId, categoryId);
      onSaved();
    } catch {
      setError(intl.formatMessage({ id: "targets.editor.error", defaultMessage: "We could not save this target." }));
      setSubmitting(false);
    }
  }

  return (
    <SideSheet title={categoryName} onClose={onClose}>
      <form className="target-editor" onSubmit={(event) => void handleSubmit(event)}>
        <fieldset className="types">
          <legend className="sr-only">{intl.formatMessage({ id: "targets.editor.kind", defaultMessage: "Kind" })}</legend>
          {KINDS.map((k) => (
            <label className="opt" key={k.kind}>
              <input type="radio" name="goal-kind" checked={kind === k.kind} onChange={() => setKind(k.kind)} />
              <span>
                <b>{k.label}</b>
                <small>{k.hint}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="field">
          <label htmlFor="goal-amount">
            {kind === "balance"
              ? intl.formatMessage({ id: "targets.editor.threshold", defaultMessage: "Threshold" })
              : intl.formatMessage({ id: "targets.editor.amount", defaultMessage: "Amount" })}
          </label>
          <input id="goal-amount" type="text" inputMode="decimal" value={amountStr} onChange={(event) => setAmountStr(event.target.value)} placeholder="0.00" />
        </div>

        {(kind === "by_date" || kind === "repeating") && (
          <div className="field">
            <label htmlFor="goal-due">{intl.formatMessage({ id: "targets.editor.dueMonth", defaultMessage: "Due month" })}</label>
            <input id="goal-due" type="month" value={dueMonth} onChange={(event) => setDueMonth(event.target.value)} />
          </div>
        )}

        {kind === "repeating" && (
          <div className="field">
            <label htmlFor="goal-every">{intl.formatMessage({ id: "targets.editor.every", defaultMessage: "Repeat interval" })}</label>
            <select id="goal-every" value={every} onChange={(event) => setEvery(Number(event.target.value) as RepeatInterval)}>
              {INTERVALS.map((n) => (
                <option key={n} value={n}>
                  {intl.formatMessage({ id: "targets.editor.everyMonths", defaultMessage: "Every {n} months" }, { n })}
                </option>
              ))}
            </select>
          </div>
        )}

        {preview && (
          <p className="preview">
            {intl.formatMessage(
              { id: "targets.editor.preview", defaultMessage: "Asks {asks} this month; {missing} still missing." },
              { asks: money(preview.asks), missing: money(preview.missing) },
            )}
          </p>
        )}

        {error && (
          <p className="hint bad" role="alert">
            {error}
          </p>
        )}

        <div className="row-btns">
          <button type="button" className="btn" onClick={onClose}>
            {intl.formatMessage({ id: "common.action.cancel", defaultMessage: "Cancel" })}
          </button>
          <button type="submit" className="btn primary" disabled={submitting}>
            {intl.formatMessage({ id: "targets.editor.save", defaultMessage: "Save" })}
          </button>
          {existing && (
            <button type="button" className="plain danger" disabled={submitting} onClick={() => void handleRemove()}>
              {intl.formatMessage({ id: "targets.editor.remove", defaultMessage: "Remove" })}
            </button>
          )}
        </div>
      </form>
    </SideSheet>
  );
}
