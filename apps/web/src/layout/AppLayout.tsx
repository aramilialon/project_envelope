import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { NavLink, Outlet, useParams } from "react-router-dom";

import WorkspaceSwitcher from "../workspaces/WorkspaceSwitcher.tsx";
import "./AppLayout.css";

/**
 * The mariner band (#323, docs/design.md's "User interface"): the wordmark, primary navigation,
 * the workspace switcher and the user menu, shared by every screen under `/:workspaceId`. This
 * is the band's first line only — a screen's own second line (the budget month's own month
 * navigation and unassigned-money box) is that screen's own concern, not this layout's.
 *
 * Replaces the old sidebar entirely: the account ledger that used to live here moved to the
 * Accounts screen (`#51`'s own screen, restyled by `#333`), since an account's balance is no
 * longer something every screen shows. "Portfolio" stays out of the primary navigation for the
 * same reason it always has — it has no screen yet (0.2.x), and a nav item with nowhere to go
 * is worse than no nav item.
 */
export default function AppLayout() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const intl = useIntl();
  const auth = useAuth();

  return (
    <div className="app-layout">
      <header className="band">
        <div className="bt">
          <span className="brand" aria-hidden="true">
            envelope
          </span>
          <nav className="tnav" aria-label={intl.formatMessage({ id: "layout.nav.label", defaultMessage: "Main" })}>
            <NavLink to={`/${workspaceId}`} end>
              {intl.formatMessage({ id: "layout.nav.budget", defaultMessage: "Budget" })}
            </NavLink>
            <NavLink to={`/${workspaceId}/accounts`}>
              {intl.formatMessage({ id: "layout.nav.accounts", defaultMessage: "Accounts" })}
            </NavLink>
          </nav>
          <WorkspaceSwitcher />
          <span className="who">{auth.user?.profile.name ?? auth.user?.profile.preferred_username ?? ""}</span>
          <button type="button" className="me" onClick={() => void auth.signoutRedirect()}>
            {intl.formatMessage({ id: "common.action.signOut", defaultMessage: "Sign out" })}
          </button>
        </div>
      </header>
      <div className="main">
        <Outlet />
      </div>
    </div>
  );
}
