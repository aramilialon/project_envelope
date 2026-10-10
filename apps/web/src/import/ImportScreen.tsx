import { formatMoney, parseAmount } from "@envelope/core";
import { useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { Link, useParams } from "react-router-dom";

import {
  confirmStagedTransactions,
  saveImportMapping,
  stageImport,
  type CsvDateFormat,
  type DecimalSeparator,
  type ImportFormat,
  type StagedTransaction,
  type StagedTransactionDecision,
  type StageImportResult,
} from "./api.ts";
import { detectImportFormat } from "./detectFormat.ts";
import {
  buildCsvMapping,
  guessColumnRoles,
  mappingProblems,
  rolesFromMapping,
  splitCsvPreview,
  type ColumnRole,
} from "./mapping.ts";
import { useImportSetup } from "./useImportSetup.ts";
import "./ImportScreen.css";

const DATE_FORMATS: readonly CsvDateFormat[] = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"];
const ROLES: readonly ColumnRole[] = ["", "date", "desc", "amount", "out", "in", "memo"];

const INCOME_SELECTION = "__income__";
const TRANSFER_PREFIX = "__transfer__";

function decisionFromSelection(stagedTransactionId: string, selection: string, transferCategoryId?: string): StagedTransactionDecision | undefined {
  if (!selection) {
    return undefined;
  }
  if (selection === INCOME_SELECTION) {
    return { stagedTransactionId, kind: "income" };
  }
  if (selection.startsWith(TRANSFER_PREFIX)) {
    return {
      stagedTransactionId,
      kind: "transfer",
      otherAccountId: selection.slice(TRANSFER_PREFIX.length),
      ...(transferCategoryId ? { categoryId: transferCategoryId } : {}),
    };
  }
  return { stagedTransactionId, kind: "category", categoryId: selection };
}

function shortDate(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * The import screen (#59, design.md "Import and reconciliation"), reached from the account
 * register's own "Import" button: file, columns (CSV only — OFX/QIF/CAMT.053 are self-describing
 * and skip straight to the third step), check, done — following
 * `docs/ux/mockups/import-reconciliation.html`'s own `#view-imp`, as a standalone screen (its own
 * route, like `ReconciliationScreen`, `#60`) rather than a shared tab strip with reconciliation.
 *
 * Two deliberate divergences from the literal mockup:
 *
 * - A staged row cannot be confirmed without a category, "Income" or "Transfer to …" chosen —
 *   the mockup's own `doImport()` still imports a row with none and merely counts it
 *   "uncategorized", but design.md is explicit that `transactions` itself has no such state
 *   (`packages/core` rejects an uncategorized transaction outright) and `POST
 *   .../staged-transactions/confirm` has nothing to send for a row with no decision at all —
 *   such a row simply stays staged, to be confirmed later once it has one.
 * - A staged row's payee is read-only here. The mockup draws an editable "Beneficiario" field at
 *   this step, but `apps/api` has no endpoint to change a staged row before confirming — only to
 *   stage it (with whatever the file's own description produced) and later confirm it.
 *
 * A duplicate row (the statement's own transaction, already in the register) needs no category,
 * transfer or income of its own: `POST .../staged-transactions/confirm` clears it — status
 * `cleared` — from whatever decision it is given, so every duplicate row is always included in
 * the same confirmation as the new rows the user picked.
 */
export default function ImportScreen() {
  const intl = useIntl();
  const auth = useAuth();
  const { workspaceId, accountId } = useParams<{ workspaceId: string; accountId: string }>();
  const setup = useImportSetup(workspaceId!, accountId!);

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState("");
  const [content, setContent] = useState("");
  const [format, setFormat] = useState<ImportFormat>("csv");
  const [closingBalanceStr, setClosingBalanceStr] = useState("");

  const [hasHeaderRow, setHasHeaderRow] = useState(true);
  const [dateFormat, setDateFormat] = useState<CsvDateFormat>("YYYY-MM-DD");
  const [decimalSeparator, setDecimalSeparator] = useState<DecimalSeparator>(".");
  const [roles, setRoles] = useState<ColumnRole[]>([]);
  const [remember, setRemember] = useState(true);

  const [stageResult, setStageResult] = useState<StageImportResult | null>(null);
  const [includes, setIncludes] = useState<Record<string, boolean>>({});
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [transferCategories, setTransferCategories] = useState<Record<string, string>>({});
  const [confirmResult, setConfirmResult] = useState<{ confirmed: number; clearedDuplicates: number; rejected: number; stillStaged: number } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (setup.status === "loading") {
    return <p role="status">{intl.formatMessage({ id: "import.loading", defaultMessage: "Loading this account…" })}</p>;
  }
  if (setup.status === "error") {
    return <p role="alert">{intl.formatMessage({ id: "import.error", defaultMessage: "We could not load this account." })}</p>;
  }
  const { account, accounts, categories, savedMapping } = setup;
  const currency = account.currency;
  const money = (cents: number) => formatMoney(cents, { locale: intl.locale, currency });
  const otherAccounts = accounts.filter((a) => a.id !== accountId);
  const openCategories = categories.filter((c) => !c.archived);

  // design.md, "Account register": "transfers to an off-budget account ask for a category" —
  // money is leaving or entering the budget, the same as ordinary spending (#378, #379).
  function needsTransferCategory(selection: string): boolean {
    if (!selection.startsWith(TRANSFER_PREFIX)) {
      return false;
    }
    const other = otherAccounts.find((a) => a.id === selection.slice(TRANSFER_PREFIX.length));
    return other !== undefined && other.onBudget !== account.onBudget;
  }

  function rowIsReady(selection: string | undefined, transferCategoryId: string | undefined): boolean {
    if (!selection) {
      return false;
    }
    return !needsTransferCategory(selection) || !!transferCategoryId;
  }

  function closingBalanceCents(): number | undefined {
    if (!closingBalanceStr.trim()) {
      return undefined;
    }
    try {
      return parseAmount(closingBalanceStr, { locale: intl.locale, currency });
    } catch {
      return undefined;
    }
  }

  function initializeSelections(staged: readonly StagedTransaction[]) {
    const nextIncludes: Record<string, boolean> = {};
    const nextSelections: Record<string, string> = {};
    for (const row of staged) {
      nextIncludes[row.id] = row.duplicateOf === null;
      nextSelections[row.id] = "";
    }
    setIncludes(nextIncludes);
    setSelections(nextSelections);
  }

  async function handleFile(file: File) {
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    const text = await file.text();
    const detected = detectImportFormat(file.name);
    setFileName(file.name);
    setContent(text);
    setFormat(detected);
    setError(null);

    if (detected !== "csv") {
      setSubmitting(true);
      try {
        const result = await stageImport(accessToken, workspaceId!, accountId!, {
          content: text,
          format: detected,
          ...(closingBalanceCents() !== undefined ? { closingBalanceCents: closingBalanceCents()! } : {}),
        });
        setStageResult(result);
        initializeSelections(result.staged);
        setStep(3);
      } catch {
        setError(intl.formatMessage({ id: "import.error.stage", defaultMessage: "We could not read this file." }));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const rows = splitCsvPreview(text);
    const header = rows[0] ?? [];
    if (savedMapping) {
      setRoles(rolesFromMapping(savedMapping, header.length));
      setHasHeaderRow(savedMapping.hasHeaderRow);
      setDateFormat(savedMapping.dateFormat);
      setDecimalSeparator(savedMapping.decimalSeparator);
    } else {
      setRoles(guessColumnRoles(header));
    }
    setStep(2);
  }

  function handleFileInput(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      void handleFile(file);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files[0];
    if (file) {
      void handleFile(file);
    }
  }

  async function handleContinueFromColumns() {
    const accessToken = auth.user?.access_token;
    const mapping = buildCsvMapping(roles, { hasHeaderRow, dateFormat, decimalSeparator });
    if (!accessToken || !mapping) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await stageImport(accessToken, workspaceId!, accountId!, {
        content,
        format: "csv",
        mapping,
        ...(closingBalanceCents() !== undefined ? { closingBalanceCents: closingBalanceCents()! } : {}),
      });
      if (remember) {
        await saveImportMapping(accessToken, workspaceId!, accountId!, mapping);
      }
      setStageResult(result);
      initializeSelections(result.staged);
      setStep(3);
    } catch {
      setError(intl.formatMessage({ id: "import.error.stage", defaultMessage: "We could not read this file." }));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirm() {
    const accessToken = auth.user?.access_token;
    if (!accessToken || !stageResult) {
      return;
    }
    const decisions: StagedTransactionDecision[] = [];
    for (const row of stageResult.staged) {
      if (row.duplicateOf !== null) {
        // Inert: the server clears a duplicate row from its own staged record, whatever decision it is given.
        decisions.push({ stagedTransactionId: row.id, kind: "income" });
      } else if (includes[row.id] && rowIsReady(selections[row.id], transferCategories[row.id])) {
        const decision = decisionFromSelection(row.id, selections[row.id]!, transferCategories[row.id]);
        if (decision) {
          decisions.push(decision);
        }
      }
    }
    if (decisions.length === 0) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const outcomes = await confirmStagedTransactions(accessToken, workspaceId!, accountId!, decisions);
      setConfirmResult({
        confirmed: outcomes.filter((o) => o.outcome === "confirmed").length,
        clearedDuplicates: outcomes.filter((o) => o.outcome === "duplicate_cleared").length,
        rejected: outcomes.filter((o) => o.outcome === "rejected").length,
        stillStaged: stageResult.staged.length - decisions.length,
      });
      setStep(4);
    } catch {
      setError(intl.formatMessage({ id: "import.error.confirm", defaultMessage: "We could not confirm these transactions." }));
    } finally {
      setSubmitting(false);
    }
  }

  function startOver() {
    setStep(1);
    setFileName("");
    setContent("");
    setClosingBalanceStr("");
    setStageResult(null);
    setIncludes({});
    setSelections({});
    setTransferCategories({});
    setConfirmResult(null);
    setError(null);
  }

  const STEPS: readonly string[] = [
    intl.formatMessage({ id: "import.step.file", defaultMessage: "File" }),
    intl.formatMessage({ id: "import.step.columns", defaultMessage: "Columns" }),
    intl.formatMessage({ id: "import.step.check", defaultMessage: "Check" }),
    intl.formatMessage({ id: "import.step.done", defaultMessage: "Done" }),
  ];

  const problems = mappingProblems(roles);
  const previewRows = format === "csv" ? splitCsvPreview(content) : [];
  const dataRows = hasHeaderRow ? previewRows.slice(1) : previewRows;
  const headerRow = previewRows[0] ?? [];

  const staged = stageResult?.staged ?? [];
  const newRows = staged.filter((r) => r.duplicateOf === null);
  const duplicateRows = staged.filter((r) => r.duplicateOf !== null);
  const readyCount = newRows.filter((r) => includes[r.id] && rowIsReady(selections[r.id], transferCategories[r.id])).length;
  const missingCount = newRows.filter((r) => includes[r.id] && !rowIsReady(selections[r.id], transferCategories[r.id])).length;
  const canConfirm = readyCount > 0 || duplicateRows.length > 0;

  return (
    <div className="import-screen">
      <Link className="crumb-back" to={`/${workspaceId}/accounts/${accountId}`}>
        ← {account.name}
      </Link>
      <h1 className="page-h">{intl.formatMessage({ id: "import.title", defaultMessage: "Import a bank statement" })}</h1>

      <ol className="steps">
        {STEPS.map((label, index) => {
          const n = index + 1;
          const cls = n < step ? "done" : n === step ? "now" : "";
          return (
            <li key={label} className={cls} aria-current={n === step ? "step" : undefined}>
              <span className="num">{n < step ? "✓" : n}</span>
              {label}
            </li>
          );
        })}
      </ol>

      {error && (
        <p className="hint bad" role="alert">
          {error}
        </p>
      )}

      <div className="stage">
        {step === 1 && (
          <>
            <label
              className={`drop${dragOver ? " over" : ""}`}
              htmlFor="import-file-in"
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <b>{intl.formatMessage({ id: "import.drop.title", defaultMessage: "Drop your bank statement here" })}</b>
              <span className="hint">
                {intl.formatMessage({
                  id: "import.drop.hint",
                  defaultMessage: "CSV, OFX, QIF or CAMT.053, just as you download it from your bank. The file is read and never stored.",
                })}
              </span>
              <span className="btn">{intl.formatMessage({ id: "import.drop.choose", defaultMessage: "Choose a file" })}</span>
            </label>
            <input id="import-file-in" type="file" className="file-in" accept=".csv,.txt,.ofx,.qif,.xml" onChange={handleFileInput} />
            <div className="field">
              <label htmlFor="import-closing-balance">
                {intl.formatMessage({ id: "import.closingBalance", defaultMessage: "Closing balance on the statement (optional)" })}
              </label>
              <span className="money-in">
                <input
                  id="import-closing-balance"
                  type="text"
                  inputMode="decimal"
                  value={closingBalanceStr}
                  onChange={(event) => setClosingBalanceStr(event.target.value)}
                  placeholder="0.00"
                />
              </span>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <p>
              {intl.formatMessage(
                { id: "import.columns.intro", defaultMessage: "File {name}: {count} rows. Tell us what each column holds; a column you don't need can be ignored." },
                { name: <b key="name">{fileName}</b>, count: dataRows.length },
              )}
            </p>
            <div className="opts">
              <label className="check">
                <input type="checkbox" checked={hasHeaderRow} onChange={(event) => setHasHeaderRow(event.target.checked)} />
                {intl.formatMessage({ id: "import.columns.hasHeader", defaultMessage: "The first row holds column names" })}
              </label>
              <div className="field">
                <label htmlFor="import-datefmt">{intl.formatMessage({ id: "import.columns.dateFormat", defaultMessage: "Date format" })}</label>
                <select id="import-datefmt" value={dateFormat} onChange={(event) => setDateFormat(event.target.value as CsvDateFormat)}>
                  {DATE_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="import-dec">{intl.formatMessage({ id: "import.columns.decimalSeparator", defaultMessage: "Decimal separator" })}</label>
                <select id="import-dec" value={decimalSeparator} onChange={(event) => setDecimalSeparator(event.target.value as DecimalSeparator)}>
                  <option value=".">{intl.formatMessage({ id: "import.columns.decimalSeparator.dot", defaultMessage: "dot (1,234.56)" })}</option>
                  <option value=",">{intl.formatMessage({ id: "import.columns.decimalSeparator.comma", defaultMessage: "comma (1.234,56)" })}</option>
                </select>
              </div>
            </div>
            <div className="mapwrap">
              <table className="map">
                <thead>
                  <tr>
                    {headerRow.map((header, c) => (
                      <th key={c}>
                        <label className="sr-only" htmlFor={`import-role-${c}`}>
                          {intl.formatMessage({ id: "import.columns.column", defaultMessage: "Column {n}" }, { n: c + 1 })}
                        </label>
                        <select id={`import-role-${c}`} value={roles[c] ?? ""} onChange={(event) => setRoles((r) => r.map((role, i) => (i === c ? (event.target.value as ColumnRole) : role)))}>
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {roleLabel(r, intl)}
                            </option>
                          ))}
                        </select>
                        {hasHeaderRow && <div className="raw">{header}</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dataRows.slice(0, 6).map((row, i) => (
                    <tr key={i}>
                      {row.map((value, c) => (
                        <td key={c} className={roles[c] ? "" : "muted"}>
                          {value}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {problems.length > 0 ? (
              <p className="hint bad" role="alert">
                {problems.includes("missing_date") && intl.formatMessage({ id: "import.columns.problem.date", defaultMessage: "Pick the date column. " })}
                {problems.includes("missing_description") && intl.formatMessage({ id: "import.columns.problem.description", defaultMessage: "Pick the description column. " })}
                {problems.includes("missing_amount") &&
                  intl.formatMessage({ id: "import.columns.problem.amount", defaultMessage: "Pick the amount column, or both an outflow and an inflow column." })}
              </p>
            ) : (
              <span className="ok">{intl.formatMessage({ id: "import.columns.ok", defaultMessage: "Columns look good." })}</span>
            )}
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              {intl.formatMessage({ id: "import.columns.remember", defaultMessage: "Remember these settings for {account}" }, { account: account.name })}
            </label>
            <div className="row-btns">
              <button type="button" className="btn" onClick={() => setStep(1)}>
                {intl.formatMessage({ id: "import.back", defaultMessage: "Back" })}
              </button>
              <button type="button" className="btn primary" disabled={problems.length > 0 || submitting} onClick={() => void handleContinueFromColumns()}>
                {intl.formatMessage({ id: "import.continue", defaultMessage: "Continue" })}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="sum">
              <div>
                <small>{intl.formatMessage({ id: "import.check.rows", defaultMessage: "Rows" })}</small>
                <b className="n">{staged.length}</b>
              </div>
              <div>
                <small>{intl.formatMessage({ id: "import.check.already", defaultMessage: "Already in the register" })}</small>
                <b className="n">{duplicateRows.length}</b>
              </div>
              <div>
                <small>{intl.formatMessage({ id: "import.check.new", defaultMessage: "New" })}</small>
                <b className="n">{newRows.length}</b>
              </div>
              <div>
                <small>{intl.formatMessage({ id: "import.check.missing", defaultMessage: "Still need a category" })}</small>
                <b className="n" style={missingCount > 0 ? { color: "var(--warn)" } : undefined}>
                  {missingCount}
                </b>
              </div>
            </div>
            <p className="hint">
              {intl.formatMessage({
                id: "import.check.hint",
                defaultMessage: "Rows already in the register (same amount, dates within 3 days) are not imported again; a pending one becomes cleared. A new row needs a category, or to be marked as income or a transfer, before it can be imported — one without it stays staged, to confirm later.",
              })}
            </p>
            <div className="ihead icols">
              <span />
              <span>{intl.formatMessage({ id: "import.check.column.date", defaultMessage: "Date" })}</span>
              <span>{intl.formatMessage({ id: "import.check.column.description", defaultMessage: "From the bank" })}</span>
              <span>{intl.formatMessage({ id: "import.check.column.category", defaultMessage: "Category" })}</span>
              <span className="r">{intl.formatMessage({ id: "import.check.column.amount", defaultMessage: "Amount" })}</span>
            </div>
            {staged.map((row) => {
              const isDuplicate = row.duplicateOf !== null;
              return (
                <div key={row.id} className={`irow icols${isDuplicate || !includes[row.id] ? " skip" : ""}`}>
                  {isDuplicate ? (
                    <input type="checkbox" checked disabled aria-label={intl.formatMessage({ id: "import.check.alreadyRegistered", defaultMessage: "Already in the register" })} />
                  ) : (
                    <input
                      type="checkbox"
                      aria-label={intl.formatMessage({ id: "import.check.includeRow", defaultMessage: "Import this row" })}
                      checked={includes[row.id] ?? false}
                      onChange={(event) => setIncludes((current) => ({ ...current, [row.id]: event.target.checked }))}
                    />
                  )}
                  <span className="n">{shortDate(row.occurredAt, intl.locale)}</span>
                  <span>
                    <span className="raw" title={row.payee ?? ""}>
                      {row.payee ?? ""}
                    </span>
                    {isDuplicate ? (
                      <span className="badge dup">{intl.formatMessage({ id: "import.check.badge.duplicate", defaultMessage: "Already there" })}</span>
                    ) : !rowIsReady(selections[row.id], transferCategories[row.id]) ? (
                      <span className="badge need">{intl.formatMessage({ id: "import.check.badge.need", defaultMessage: "Needs a category" })}</span>
                    ) : (
                      <span className="badge new">{intl.formatMessage({ id: "import.check.badge.new", defaultMessage: "New" })}</span>
                    )}
                  </span>
                  {isDuplicate ? (
                    <span className="hint">{intl.formatMessage({ id: "import.check.becomesCleared", defaultMessage: "becomes cleared" })}</span>
                  ) : (
                    <span>
                      <label className="sr-only" htmlFor={`import-cat-${row.id}`}>
                        {intl.formatMessage({ id: "import.check.column.category", defaultMessage: "Category" })}
                      </label>
                      <select
                        id={`import-cat-${row.id}`}
                        value={selections[row.id] ?? ""}
                        onChange={(event) => setSelections((current) => ({ ...current, [row.id]: event.target.value }))}
                      >
                        <option value="">{intl.formatMessage({ id: "import.check.chooseCategory", defaultMessage: "Choose a category" })}</option>
                        <option value={INCOME_SELECTION}>{intl.formatMessage({ id: "import.check.income", defaultMessage: "Income" })}</option>
                        {otherAccounts.map((other) => (
                          <option key={other.id} value={`${TRANSFER_PREFIX}${other.id}`}>
                            {intl.formatMessage({ id: "import.check.transferTo", defaultMessage: "Transfer to {account}" }, { account: other.name })}
                          </option>
                        ))}
                        {openCategories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                      {needsTransferCategory(selections[row.id] ?? "") && (
                        <>
                          <label className="sr-only" htmlFor={`import-transfer-cat-${row.id}`}>
                            {intl.formatMessage({ id: "import.check.column.category", defaultMessage: "Category" })}
                          </label>
                          <select
                            id={`import-transfer-cat-${row.id}`}
                            value={transferCategories[row.id] ?? ""}
                            onChange={(event) => setTransferCategories((current) => ({ ...current, [row.id]: event.target.value }))}
                          >
                            <option value="">{intl.formatMessage({ id: "import.check.chooseCategory", defaultMessage: "Choose a category" })}</option>
                            {openCategories.map((category) => (
                              <option key={category.id} value={category.id}>
                                {category.name}
                              </option>
                            ))}
                          </select>
                        </>
                      )}
                    </span>
                  )}
                  <span className="r n">{money(row.amountCents)}</span>
                </div>
              );
            })}
            <div className="row-btns">
              <button type="button" className="btn" onClick={() => (format === "csv" ? setStep(2) : setStep(1))}>
                {intl.formatMessage({ id: "import.back", defaultMessage: "Back" })}
              </button>
              <button type="button" className="btn primary" disabled={!canConfirm || submitting} onClick={() => void handleConfirm()}>
                {intl.formatMessage(
                  { id: "import.confirm", defaultMessage: "Import {count, plural, one {# transaction} other {# transactions}}" },
                  { count: readyCount + duplicateRows.length },
                )}
              </button>
            </div>
          </>
        )}

        {step === 4 && confirmResult && (
          <div className="done-box">
            <h4>{intl.formatMessage({ id: "import.done.title", defaultMessage: "Import complete" })}</h4>
            <p>
              {intl.formatMessage(
                {
                  id: "import.done.summary",
                  defaultMessage:
                    "{confirmed, plural, one {# transaction} other {# transactions}} added as cleared{clearedDuplicates, plural, =0 {} other {, # already there marked cleared}}.",
                },
                { confirmed: confirmResult.confirmed, clearedDuplicates: confirmResult.clearedDuplicates },
              )}
            </p>
            {confirmResult.stillStaged > 0 && (
              <p className="hint">
                {intl.formatMessage(
                  { id: "import.done.stillStaged", defaultMessage: "{count, plural, one {# row is} other {# rows are}} still waiting for a category, income or transfer." },
                  { count: confirmResult.stillStaged },
                )}
              </p>
            )}
            {stageResult?.closingBalance && (
              <p className="hint">
                {stageResult.closingBalance.differenceCents === 0
                  ? intl.formatMessage({ id: "import.done.balanceMatches", defaultMessage: "The statement's closing balance matches the account." })
                  : intl.formatMessage(
                      { id: "import.done.balanceDiffers", defaultMessage: "The statement's closing balance differs from the account by {amount}: check with reconciliation." },
                      { amount: money(stageResult.closingBalance.differenceCents) },
                    )}
              </p>
            )}
            <div className="row-btns">
              <Link className="btn primary" to={`/${workspaceId}/accounts/${accountId}/reconcile`}>
                {intl.formatMessage({ id: "import.done.reconcile", defaultMessage: "Reconcile now" })}
              </Link>
              <button type="button" className="btn" onClick={startOver}>
                {intl.formatMessage({ id: "import.done.another", defaultMessage: "Import another file" })}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function roleLabel(role: ColumnRole, intl: ReturnType<typeof useIntl>): string {
  switch (role) {
    case "":
      return intl.formatMessage({ id: "import.role.ignore", defaultMessage: "Ignore" });
    case "date":
      return intl.formatMessage({ id: "import.role.date", defaultMessage: "Date" });
    case "desc":
      return intl.formatMessage({ id: "import.role.description", defaultMessage: "Description" });
    case "amount":
      return intl.formatMessage({ id: "import.role.amount", defaultMessage: "Amount" });
    case "out":
      return intl.formatMessage({ id: "import.role.outflow", defaultMessage: "Outflow" });
    case "in":
      return intl.formatMessage({ id: "import.role.inflow", defaultMessage: "Inflow" });
    case "memo":
      return intl.formatMessage({ id: "import.role.memo", defaultMessage: "Memo" });
  }
}
