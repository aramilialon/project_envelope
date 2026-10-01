import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import * as api from "./api.ts";
import Home from "./Home.tsx";
import { renderWithIntl } from "./test-utils.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function renderHome(path = "/ws-1") {
  return renderWithIntl(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:workspaceId" element={<Home />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Home (#48, #49, #50)", () => {
  it("shows a connected status once the API answers ok", async () => {
    useAuth.mockReturnValue({ isAuthenticated: true, signoutRedirect: vi.fn(), user: undefined });
    vi.spyOn(api, "checkHealth").mockResolvedValue("ok");
    renderHome();

    expect(await screen.findByRole("status")).toHaveTextContent("Connected to the API.");
  });

  it("shows an unreachable status when the API does not answer", async () => {
    useAuth.mockReturnValue({ isAuthenticated: true, signoutRedirect: vi.fn(), user: undefined });
    vi.spyOn(api, "checkHealth").mockResolvedValue("error");
    renderHome();

    expect(await screen.findByRole("status")).toHaveTextContent("Could not reach the API.");
  });

  it("signs out through react-oidc-context when the sign-out button is clicked", async () => {
    const signoutRedirect = vi.fn();
    useAuth.mockReturnValue({ isAuthenticated: true, signoutRedirect, user: undefined });
    vi.spyOn(api, "checkHealth").mockResolvedValue("ok");
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(signoutRedirect).toHaveBeenCalledOnce();
  });
});
