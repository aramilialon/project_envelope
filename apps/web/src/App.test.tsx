import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import App from "./App.tsx";
import * as api from "./api.ts";
import { renderWithIntl } from "./test-utils.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth, AuthProvider: ({ children }: { children: unknown }) => children }));

describe("App (#48, #49)", () => {
  it("shows the sign-in screen when not authenticated", () => {
    useAuth.mockReturnValue({ isAuthenticated: false, isLoading: false, error: undefined });
    renderWithIntl(<App />);

    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows a connected status once the API answers ok, once authenticated", async () => {
    useAuth.mockReturnValue({ isAuthenticated: true, isLoading: false, error: undefined, signoutRedirect: vi.fn() });
    vi.spyOn(api, "checkHealth").mockResolvedValue("ok");
    renderWithIntl(<App />);

    expect(await screen.findByRole("status")).toHaveTextContent("Connected to the API.");
  });

  it("shows an unreachable status when the API does not answer, once authenticated", async () => {
    useAuth.mockReturnValue({ isAuthenticated: true, isLoading: false, error: undefined, signoutRedirect: vi.fn() });
    vi.spyOn(api, "checkHealth").mockResolvedValue("error");
    renderWithIntl(<App />);

    expect(await screen.findByRole("status")).toHaveTextContent("Could not reach the API.");
  });

  it("signs out through react-oidc-context when the sign-out button is clicked", async () => {
    const signoutRedirect = vi.fn();
    useAuth.mockReturnValue({ isAuthenticated: true, isLoading: false, error: undefined, signoutRedirect });
    vi.spyOn(api, "checkHealth").mockResolvedValue("ok");
    renderWithIntl(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(signoutRedirect).toHaveBeenCalledOnce();
  });
});
