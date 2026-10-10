import { useState } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";

import NotificationsToggle from "../notifications/NotificationsToggle.tsx";
import QuickEntryOverlay from "../transactions/QuickEntryOverlay.tsx";
import { useWorkspaces } from "../workspaces/useWorkspaces.ts";
import WorkspaceSwitcher from "../workspaces/WorkspaceSwitcher.tsx";
import { BandSecondRowSlotContext } from "./bandSecondRowSlot.ts";
import { BudgetDataVersionContext } from "./budgetDataVersion.ts";
import { usePhoneWidth } from "./usePhoneWidth.ts";
import "./AppLayout.css";

/**
 * The mariner band (#323/#324, docs/design.md's "User interface"): the wordmark, primary
 * navigation, the workspace switcher and the user menu, shared by every screen under
 * `/:workspaceId` — plus, below it, the second-line slot screens can portal into (above).
 *
 * Replaces the old sidebar entirely: the account ledger that used to live here moved to the
 * Accounts screen (`#51`'s own screen, restyled by `#333`), since an account's balance is no
 * longer something every screen shows. "Portfolio" stays out of the primary navigation for the
 * same reason it always has — it has no screen yet (0.2.x), and a nav item with nowhere to go
 * is worse than no nav item.
 *
 * Below 600px (`usePhoneWidth`), a fixed tab bar (design.md, "Budget month on the phone") adds
 * bottom-of-thumb navigation on every screen, alongside the band above (kept, not replaced — it
 * is still the only way to reach the workspace switcher and sign out on a phone, since nothing in
 * design.md says those move elsewhere). "Portfolio" stays out of the tab bar too, same reason as
 * the band's own nav above. The central button opens `QuickEntryOverlay` (`#367`) — rendered here,
 * not a route, so closing it returns to exactly whatever screen was open underneath, not a fresh
 * remount of it; hidden for a `read_only` member, the same `canWrite` convention `BudgetScreen.tsx`
 * already uses (`#61`), since recording an expense is a write. "More" goes to the one
 * workspace-settings destination that exists so far, the same place the band's own switcher menu
 * sends it.
 */
export default function AppLayout() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const intl = useIntl();
  const auth = useAuth();
  const navigate = useNavigate();
  const isPhone = usePhoneWidth();
  const workspaces = useWorkspaces();
  const currentWorkspace = workspaces.status === "ok" ? workspaces.workspaces.find((w) => w.id === workspaceId) : undefined;
  const canWrite = currentWorkspace?.role === "owner" || currentWorkspace?.role === "editor";
  const [secondRowSlot, setSecondRowSlot] = useState<HTMLDivElement | null>(null);
  const [quickEntryOpen, setQuickEntryOpen] = useState(false);
  const [budgetDataVersion, setBudgetDataVersion] = useState(0);

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
          <NotificationsToggle />
          <button type="button" className="me" onClick={() => void auth.signoutRedirect()}>
            {intl.formatMessage({ id: "common.action.signOut", defaultMessage: "Sign out" })}
          </button>
        </div>
        <div className="bm" ref={setSecondRowSlot} />
      </header>
      <div className="main">
        <BandSecondRowSlotContext.Provider value={secondRowSlot}>
          <BudgetDataVersionContext.Provider value={budgetDataVersion}>
            <Outlet />
          </BudgetDataVersionContext.Provider>
        </BandSecondRowSlotContext.Provider>
      </div>
      {isPhone && (
        <nav className="tabbar" aria-label={intl.formatMessage({ id: "layout.tabbar.label", defaultMessage: "Main, phone" })}>
          <NavLink to={`/${workspaceId}`} end>
            <BudgetIcon />
            {intl.formatMessage({ id: "layout.nav.budget", defaultMessage: "Budget" })}
          </NavLink>
          <NavLink to={`/${workspaceId}/accounts`}>
            <AccountsIcon />
            {intl.formatMessage({ id: "layout.nav.accounts", defaultMessage: "Accounts" })}
          </NavLink>
          {canWrite && (
            <button
              type="button"
              className="add"
              aria-label={intl.formatMessage({ id: "quickEntry.newExpense", defaultMessage: "New expense" })}
              onClick={() => setQuickEntryOpen(true)}
            >
              <PlusIcon />
            </button>
          )}
          <button type="button" onClick={() => navigate(`/${workspaceId}/settings/categories`)}>
            <MoreIcon />
            {intl.formatMessage({ id: "layout.tabbar.more", defaultMessage: "More" })}
          </button>
        </nav>
      )}
      {quickEntryOpen && workspaceId && (
        <QuickEntryOverlay
          workspaceId={workspaceId}
          onClose={() => setQuickEntryOpen(false)}
          onSaved={() => setBudgetDataVersion((v) => v + 1)}
        />
      )}
    </div>
  );
}

function BudgetIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  );
}

function AccountsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h10" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </svg>
  );
}
