import { screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as workspacesApi from "./api.ts";
import { setLastUsedWorkspaceId } from "./lastUsedWorkspace.ts";
import WorkspaceGate from "./WorkspaceGate.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function renderGate(subject?: string) {
  useAuth.mockReturnValue({ user: { access_token: "t", profile: subject ? { sub: subject } : undefined } });
  return renderWithIntl(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<WorkspaceGate />} />
        <Route path="/:workspaceId" element={<p>Landed on a workspace</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WorkspaceGate (#50)", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows a loading state while fetching", () => {
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockReturnValue(new Promise(() => {}));
    renderGate();

    expect(screen.getByRole("status")).toHaveTextContent("Loading your workspaces…");
  });

  it("shows an error state when the request fails", async () => {
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockRejectedValue(new Error("network"));
    renderGate();

    expect(await screen.findByRole("alert")).toHaveTextContent("We could not load your workspaces.");
  });

  it("shows an empty message when the user belongs to no workspace", async () => {
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([]);
    renderGate();

    expect(await screen.findByText("You do not belong to any workspace yet.")).toBeInTheDocument();
  });

  it("skips straight to the only workspace when there is exactly one", async () => {
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
      { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    ]);
    renderGate();

    expect(await screen.findByText("Landed on a workspace")).toBeInTheDocument();
  });

  it("shows the picker when there is more than one workspace", async () => {
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
      { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
      { id: "ws-2", name: "Personale", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    ]);
    renderGate();

    expect(await screen.findByRole("button", { name: "Famiglia" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Personale" })).toBeInTheDocument();
  });

  it("goes straight to the last-used workspace, skipping the picker, when the user is still a member (#343)", async () => {
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
      { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
      { id: "ws-2", name: "Personale", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    ]);
    setLastUsedWorkspaceId("user-1", "ws-2");
    renderGate("user-1");

    expect(await screen.findByText("Landed on a workspace")).toBeInTheDocument();
  });

  it("falls through to the picker, and forgets the preference, when the last-used workspace is no longer reachable (#343)", async () => {
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
      { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
      { id: "ws-2", name: "Personale", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    ]);
    setLastUsedWorkspaceId("user-1", "ws-removed");
    renderGate("user-1");

    expect(await screen.findByRole("button", { name: "Famiglia" })).toBeInTheDocument();
    expect(localStorage.getItem("envelope.lastWorkspaceId.user-1")).toBeNull();
  });

  it("ignores a last-used workspace stored under a different user's own key (#343)", async () => {
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
      { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
      { id: "ws-2", name: "Personale", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    ]);
    setLastUsedWorkspaceId("someone-else", "ws-2");
    renderGate("user-1");

    expect(await screen.findByRole("button", { name: "Famiglia" })).toBeInTheDocument();
  });

  it("falls through to the picker without crashing when localStorage itself throws (#343)", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    vi.spyOn(workspacesApi, "listMyWorkspaces").mockResolvedValue([
      { id: "ws-1", name: "Famiglia", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
      { id: "ws-2", name: "Personale", role: "owner", baseCurrency: "EUR", timeZone: "Europe/Rome" },
    ]);
    renderGate("user-1");

    expect(await screen.findByRole("button", { name: "Famiglia" })).toBeInTheDocument();
  });
});
