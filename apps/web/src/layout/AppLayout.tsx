import { useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";

import AddAccountForm from "../accounts/AddAccountForm.tsx";
import { useAccounts } from "../accounts/useAccounts.ts";
import { useWorkspaces } from "../workspaces/useWorkspaces.ts";
import WorkspaceSwitcher from "../workspaces/WorkspaceSwitcher.tsx";
import "./AppLayout.css";

/**
 * The persistent sidebar (`docs/ux/README.md`, "Navigation structure"): the workspace switcher,
 * primary navigation, the account ledger and "Add account", and the user menu — shared by every
 * screen under `/:workspaceId` (#51). "Portfolio" is left out of the primary navigation for the
 * same reason `WorkspaceSwitcher` already leaves out "Workspace settings": it has no screen yet
 * (0.2.x), and a nav item that goes nowhere is worse than no nav item.
 */
export default function AppLayout() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const intl = useIntl();
  const auth = useAuth();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const accounts = useAccounts(workspaceId!);
  const [addingAccount, setAddingAccount] = useState(false);

  const currentWorkspace = workspaces.status === "ok" ? workspaces.workspaces.find((w) => w.id === workspaceId) : undefined;
  const openAccounts = accounts.status === "ok" ? accounts.accounts.filter((a) => a.closedAt === null) : [];
  const onBudget = openAccounts.filter((a) => a.onBudget);
  const offBudget = openAccounts.filter((a) => !a.onBudget);

  return (
    <div className="app-layout">
      <nav className="side" aria-label={intl.formatMessage({ id: "layout.nav.label", defaultMessage: "Main" })}>
        <div className="brand">
          <p className="mark" aria-hidden="true">
            envelope
          </p>
          <WorkspaceSwitcher />
        </div>
        <div className="nav">
          <NavLink to={`/${workspaceId}`} end>
            {intl.formatMessage({ id: "layout.nav.budget", defaultMessage: "Budget" })}
          </NavLink>
          <NavLink to={`/${workspaceId}/accounts`}>
            {intl.formatMessage({ id: "layout.nav.accounts", defaultMessage: "Accounts" })}
          </NavLink>
        </div>
        {onBudget.length > 0 && (
          <div className="ledger">
            <h5>{intl.formatMessage({ id: "layout.ledger.onBudget", defaultMessage: "On budget" })}</h5>
            {onBudget.map((account) => (
              <button type="button" className="lr" key={account.id} onClick={() => navigate(`/${workspaceId}/accounts/${account.id}`)}>
                <span>{account.name}</span>
              </button>
            ))}
          </div>
        )}
        {offBudget.length > 0 && (
          <div className="ledger">
            <h5>{intl.formatMessage({ id: "layout.ledger.offBudget", defaultMessage: "Off budget" })}</h5>
            {offBudget.map((account) => (
              <button type="button" className="lr" key={account.id} onClick={() => navigate(`/${workspaceId}/accounts/${account.id}`)}>
                <span>{account.name}</span>
              </button>
            ))}
          </div>
        )}
        <button type="button" className="plain" onClick={() => setAddingAccount(true)}>
          {intl.formatMessage({ id: "layout.addAccount", defaultMessage: "+ Add account" })}
        </button>
        <div className="me">
          <span>{auth.user?.profile.name ?? auth.user?.profile.preferred_username ?? ""}</span>
          <button type="button" className="plain" onClick={() => void auth.signoutRedirect()}>
            {intl.formatMessage({ id: "common.action.signOut", defaultMessage: "Sign out" })}
          </button>
        </div>
      </nav>
      <div className="main">
        <Outlet context={accounts} />
      </div>
      {addingAccount && currentWorkspace && (
        <AddAccountForm
          workspaceId={workspaceId!}
          baseCurrency={currentWorkspace.baseCurrency}
          onClose={() => setAddingAccount(false)}
          onCreated={() => {
            setAddingAccount(false);
            accounts.refetch();
          }}
        />
      )}
    </div>
  );
}
