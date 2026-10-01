import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import SignIn from "./SignIn.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

describe("SignIn (#49)", () => {
  it("offers to sign in, and redirects on click (idle state)", () => {
    const signinRedirect = vi.fn();
    useAuth.mockReturnValue({ isLoading: false, error: undefined, signinRedirect });
    renderWithIntl(<SignIn />);

    expect(screen.getByText("Budget and portfolio, on your own server.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(signinRedirect).toHaveBeenCalledOnce();
  });

  it("shows a busy, disabled state while redirecting (pending state)", () => {
    useAuth.mockReturnValue({ isLoading: true, error: undefined, signinRedirect: vi.fn() });
    renderWithIntl(<SignIn />);

    const button = screen.getByRole("button", { name: /Signing in/ });
    expect(button).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Redirecting to the sign-in page");
  });

  it("shows the sign-in error and retries on click (error state)", () => {
    const signinRedirect = vi.fn();
    useAuth.mockReturnValue({
      isLoading: false,
      error: new Error("No matching state found in storage"),
      signinRedirect,
    });
    renderWithIntl(<SignIn />);

    expect(screen.getByRole("alert")).toHaveTextContent("We could not complete sign-in.");
    expect(screen.getByRole("alert")).toHaveTextContent("No matching state found in storage");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(signinRedirect).toHaveBeenCalledOnce();
  });
});
