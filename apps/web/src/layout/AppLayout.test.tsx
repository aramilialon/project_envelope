import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as accountsApi from "../accounts/api.ts";
import { renderWithIntl } from "../test-utils.tsx";
import * as transactionsApi from "../transactions/api.ts";
import * as workspacesApi from "../workspaces/api.ts";
import AppLayout from "./AppLayout.tsx";
import { useBandSecondRow } from "./useBandSecondRow.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

const WORKSPACE = { id: "ws-1", name: "Famiglia", role: "owner" as const, baseCurrency: "EUR", timeZone: "Europe/Rome" };

const ORIGINAL_WIDTH = window.innerWidth;

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
}

afterEach(() => {
  setWidth(ORIGINAL_WIDTH);
});

function renderLayout() {
  useAuth.mockReturnValue({
    user: { access_token: "t", profile: { name: "Giorgio" } },
    signoutRedirect: vi.fn(),
  });
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([WORKSPACE]);
  return renderWithIntl(
    <MemoryRouter initialEntries={["/ws-1"]}>
      <Routes>
        <Route path="/:workspaceId" element={<AppLayout />}>
          <Route index element={<p>Budget screen</p>} />
          <Route path="accounts" element={<p>Accounts screen</p>} />
          <Route path="accounts/:accountId" element={<p>Register screen</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AppLayout (#323)", () => {
  it("shows the band's primary navigation, with the current screen marked current", async () => {
    renderLayout();

    expect(await screen.findByRole("link", { name: "Budget" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Accounts" })).not.toHaveAttribute("aria-current");
  });

  it("omits Portfolio from the primary navigation: it has no screen yet", async () => {
    renderLayout();

    await screen.findByRole("link", { name: "Budget" });
    expect(screen.queryByText(/portfolio/i)).not.toBeInTheDocument();
  });

  it("shows the current workspace's name and the signed-in user", async () => {
    renderLayout();

    expect(await screen.findByRole("button", { name: "Famiglia" })).toBeInTheDocument();
    expect(screen.getByText("Giorgio")).toBeInTheDocument();
  });

  it("no longer shows an account ledger or '+ Add account': both moved to the Accounts screen", async () => {
    renderLayout();

    await screen.findByRole("link", { name: "Budget" });
    expect(screen.queryByRole("button", { name: "+ Add account" })).not.toBeInTheDocument();
  });

  it("portals a screen's own second band row into the band, via useBandSecondRow (#324)", async () => {
    function ScreenWithSecondRow() {
      return <>{useBandSecondRow(<p>October 2026</p>)}</>;
    }
    useAuth.mockReturnValue({ user: { access_token: "t", profile: { name: "Giorgio" } } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([WORKSPACE]);
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1"]}>
        <Routes>
          <Route path="/:workspaceId" element={<AppLayout />}>
            <Route index element={<ScreenWithSecondRow />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("October 2026")).toBeInTheDocument();
  });

  it("signs out through react-oidc-context when the sign-out button is clicked", async () => {
    const signoutRedirect = vi.fn();
    useAuth.mockReturnValue({ user: { access_token: "t", profile: { name: "Giorgio" } }, signoutRedirect });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([WORKSPACE]);
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1"]}>
        <Routes>
          <Route path="/:workspaceId" element={<AppLayout />}>
            <Route index element={<p>Budget screen</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(signoutRedirect).toHaveBeenCalledOnce();
  });

  it("shows a bottom tab bar below 600px, with Budget/Accounts/More, never Portfolio or quick entry (#331)", async () => {
    setWidth(390);
    renderLayout();

    expect(await screen.findByRole("navigation", { name: "Main, phone" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Budget" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Accounts" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
    expect(screen.queryByText(/portfolio/i)).not.toBeInTheDocument();
  });

  it("has no tab bar at desktop width", async () => {
    setWidth(1024);
    renderLayout();

    await screen.findByRole("link", { name: "Budget" });
    expect(document.querySelector(".tabbar")).not.toBeInTheDocument();
  });

  it("navigates to workspace settings from the tab bar's own 'More'", async () => {
    setWidth(390);
    useAuth.mockReturnValue({ user: { access_token: "t", profile: { name: "Giorgio" } } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([WORKSPACE]);
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1"]}>
        <Routes>
          <Route path="/:workspaceId" element={<AppLayout />}>
            <Route index element={<p>Budget screen</p>} />
            <Route path="settings/categories" element={<p>Categories screen</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(await screen.findByText("Categories screen")).toBeInTheDocument();
  });

  describe("the accounts panel (#412)", () => {
    function mockAccounts() {
      vi.spyOn(accountsApi, "listAccounts").mockResolvedValue([
        {
          id: "checking",
          workspaceId: "ws-1",
          name: "Checking",
          type: "checking",
          currency: "EUR",
          onBudget: true,
          paymentCategoryId: null,
          closedAt: null,
          createdAt: "2026-01-01",
        },
      ]);
      vi.spyOn(transactionsApi, "listTransactionsForAccount").mockResolvedValue([]);
    }

    it("is closed by default, its toggle at the band's far left, before the wordmark", async () => {
      renderLayout();

      const toggle = await screen.findByRole("button", { name: "Show accounts" });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle.nextElementSibling).toHaveTextContent("envelope");
      expect(screen.queryByRole("complementary", { name: "Accounts" })).not.toBeInTheDocument();
    });

    it("opens and closes from its toggle, which says which it will do", async () => {
      mockAccounts();
      renderLayout();

      fireEvent.click(await screen.findByRole("button", { name: "Show accounts" }));
      expect(await screen.findByRole("complementary", { name: "Accounts" })).toBeInTheDocument();
      const toggle = screen.getByRole("button", { name: "Hide accounts" });
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(toggle).toHaveAttribute("aria-controls", "accounts-panel");

      fireEvent.click(toggle);
      expect(screen.queryByRole("complementary", { name: "Accounts" })).not.toBeInTheDocument();
    });

    it("stays open while one of its rows switches the main content to that account's register", async () => {
      mockAccounts();
      renderLayout();

      fireEvent.click(await screen.findByRole("button", { name: "Show accounts" }));
      fireEvent.click(await screen.findByRole("button", { name: /^Checking/ }));

      expect(await screen.findByText("Register screen")).toBeInTheDocument();
      expect(screen.getByRole("complementary", { name: "Accounts" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Checking/ })).toHaveAttribute("aria-current", "true");
    });

    it("closes on Escape", async () => {
      mockAccounts();
      renderLayout();

      fireEvent.click(await screen.findByRole("button", { name: "Show accounts" }));
      await screen.findByRole("complementary", { name: "Accounts" });
      fireEvent.keyDown(document, { key: "Escape" });

      expect(screen.queryByRole("complementary", { name: "Accounts" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show accounts" })).toBeInTheDocument();
    });

    it("has no toggle on a phone: its mockup is desktop-only, and the tab bar's own Accounts is one tap away", async () => {
      setWidth(390);
      renderLayout();

      await screen.findByRole("navigation", { name: "Main, phone" });
      expect(screen.queryByRole("button", { name: "Show accounts" })).not.toBeInTheDocument();
    });
  });
});
