import { fireEvent, screen, waitFor } from "@testing-library/react";
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

  it("creates a workspace from '+ New workspace', landing on it and refreshing the list (#394)", async () => {
    useAuth.mockReturnValue({ user: { access_token: "t", profile: { sub: "user-1" } } });
    const FAMIGLIA = { id: "ws-1", name: "Famiglia", role: "owner" as const, baseCurrency: "EUR", timeZone: "Europe/Rome" };
    const LAVORO = { id: "ws-new", name: "Lavoro", role: "owner" as const, baseCurrency: "EUR", timeZone: "Europe/Rome" };
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValueOnce([FAMIGLIA]).mockResolvedValueOnce([FAMIGLIA, LAVORO]);
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1"]}>
        <Routes>
          <Route path="/:workspaceId" element={<WorkspaceSwitcher />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Famiglia" }));

    fireEvent.click(screen.getByRole("menuitem", { name: "+ New workspace" }));
    const createWorkspace = vi.spyOn(workspacesApi, "createWorkspace").mockResolvedValue(LAVORO);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Lavoro" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    await waitFor(() =>
      expect(createWorkspace).toHaveBeenCalledWith("t", { name: "Lavoro", baseCurrency: "EUR", timeZone: "Europe/Rome" }),
    );
    expect(await screen.findByRole("button", { name: "Lavoro" })).toBeInTheDocument();
  });

  it("offers 'Delete workspace' only to the current workspace's own owner (#394)", async () => {
    useAuth.mockReturnValue({ user: { access_token: "t", profile: { sub: "user-1" } } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
      { id: "ws-1", name: "Famiglia", role: "editor", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    ]);
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1"]}>
        <Routes>
          <Route path="/:workspaceId" element={<WorkspaceSwitcher />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Famiglia" }));

    expect(screen.queryByRole("menuitem", { name: "Delete workspace" })).not.toBeInTheDocument();
  });

  it("deletes the current workspace after typing its own name to confirm, then leaves it (#394)", async () => {
    useAuth.mockReturnValue({ user: { access_token: "t", profile: { sub: "user-1" } } });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
      { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    ]);
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1"]}>
        <Routes>
          <Route path="/:workspaceId" element={<WorkspaceSwitcher />} />
          <Route path="/" element={<p>Landed on the root</p>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Famiglia" }));

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete workspace" }));
    const deleteWorkspace = vi.spyOn(workspacesApi, "deleteWorkspace").mockResolvedValue(undefined);

    const confirmButton = screen.getByRole("button", { name: "Delete the workspace" });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("To confirm, type Famiglia"), { target: { value: "Famiglia" } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() => expect(deleteWorkspace).toHaveBeenCalledWith("t", "ws-1"));
    expect(await screen.findByText("Landed on the root")).toBeInTheDocument();
  });

  it("stores the chosen workspace as the last used one, for this user, on switch (#343)", async () => {
    renderSwitcher("user-1");
    fireEvent.click(await screen.findByRole("button", { name: "Famiglia" }));

    fireEvent.click(screen.getByRole("menuitem", { name: "Personale" }));

    expect(getLastUsedWorkspaceId("user-1")).toBe("ws-2");
  });
});
