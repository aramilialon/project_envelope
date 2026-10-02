import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as workspacesApi from "../workspaces/api.ts";
import AppLayout from "./AppLayout.tsx";
import { useBandSecondRow } from "./useBandSecondRow.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

const WORKSPACE = { id: "ws-1", name: "Famiglia", role: "owner" as const, baseCurrency: "EUR", timeZone: "Europe/Rome" };

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
});
