import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import { getLastUsedWorkspaceId } from "./lastUsedWorkspace.ts";
import WorkspacePicker from "./WorkspacePicker.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

const WORKSPACES = [
  { id: "ws-1", name: "Famiglia", role: "owner" as const, baseCurrency: "EUR", timeZone: "Europe/Rome" },
  { id: "ws-2", name: "Personale", role: "owner" as const, baseCurrency: "EUR", timeZone: "Europe/Rome" },
];

function renderPicker(subject?: string) {
  useAuth.mockReturnValue({ user: { access_token: "t", profile: subject ? { sub: subject } : undefined } });
  return renderWithIntl(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<WorkspacePicker workspaces={WORKSPACES} />} />
        <Route path="/:workspaceId" element={<p>Landed on a workspace</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WorkspacePicker (#50)", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("lists every workspace, navigating to the one chosen", async () => {
    renderPicker("user-1");
    fireEvent.click(screen.getByRole("button", { name: "Personale" }));

    expect(await screen.findByText("Landed on a workspace")).toBeInTheDocument();
  });

  it("remembers the chosen workspace as the last used one, so a later sign-in skips this screen (#343)", () => {
    renderPicker("user-1");
    fireEvent.click(screen.getByRole("button", { name: "Personale" }));

    expect(getLastUsedWorkspaceId("user-1")).toBe("ws-2");
  });

  it("never throws when there is no subject to key the preference on", () => {
    renderPicker(undefined);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Famiglia" }))).not.toThrow();
  });
});
