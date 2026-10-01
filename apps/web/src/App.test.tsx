import { screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import App from "./App.tsx";
import { renderWithIntl } from "./test-utils.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth, AuthProvider: ({ children }: { children: unknown }) => children }));

function renderApp(path = "/") {
  return renderWithIntl(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("App (#48, #49, #50)", () => {
  it("shows the sign-in screen when not authenticated", () => {
    useAuth.mockReturnValue({ isAuthenticated: false, isLoading: false, error: undefined });
    renderApp();

    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows the workspace gate once authenticated, with no workspace chosen yet", () => {
    useAuth.mockReturnValue({ isAuthenticated: true, isLoading: false, error: undefined, user: undefined });
    renderApp("/");

    expect(screen.getByRole("status")).toHaveTextContent("Loading your workspaces…");
  });
});
