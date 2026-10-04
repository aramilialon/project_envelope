import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as workspacesApi from "./api.ts";
import { getLastUsedWorkspaceId } from "./lastUsedWorkspace.ts";
import WorkspaceSwitcher from "./WorkspaceSwitcher.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function renderSwitcher(subject = "user-1") {
  useAuth.mockReturnValue({ user: { access_token: "t", profile: { sub: subject } } });
  vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
    { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    { id: "ws-2", name: "Personale", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
  ]);
  return renderWithIntl(
    <MemoryRouter initialEntries={["/ws-1"]}>
      <Routes>
        <Route path="/:workspaceId" element={<WorkspaceSwitcher />} />
        <Route path="/:workspaceId/settings/categories" element={<p>Landed on workspace settings</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WorkspaceSwitcher (#50)", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("shows the current workspace's name, and opens a popover listing every workspace", async () => {
    renderSwitcher();

    const button = await screen.findByRole("button", { name: "Famiglia" });
    fireEvent.click(button);

    expect(screen.getByRole("menuitem", { name: "Famiglia ✓" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Personale" })).toBeInTheDocument();
  });

  it("offers workspace settings, going straight to categories (#52)", async () => {
    renderSwitcher();
    fireEvent.click(await screen.findByRole("button", { name: "Famiglia" }));

    fireEvent.click(screen.getByRole("menuitem", { name: "Workspace settings" }));
    expect(await screen.findByText("Landed on workspace settings")).toBeInTheDocument();
  });

  it("still leaves out a 'new workspace' action: that feature has no screen yet", async () => {
    renderSwitcher();
    fireEvent.click(await screen.findByRole("button", { name: "Famiglia" }));

    expect(screen.queryByText(/new workspace/i)).not.toBeInTheDocument();
  });

  it("stores the chosen workspace as the last used one, for this user, on switch (#343)", async () => {
    renderSwitcher("user-1");
    fireEvent.click(await screen.findByRole("button", { name: "Famiglia" }));

    fireEvent.click(screen.getByRole("menuitem", { name: "Personale" }));

    expect(getLastUsedWorkspaceId("user-1")).toBe("ws-2");
  });
});
