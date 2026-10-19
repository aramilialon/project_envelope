import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as workspacesApi from "./api.ts";
import CreateWorkspaceForm from "./CreateWorkspaceForm.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function renderForm(onCreated = vi.fn(), onClose = vi.fn()) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  renderWithIntl(<CreateWorkspaceForm onClose={onClose} onCreated={onCreated} />);
  return { onCreated, onClose };
}

describe("CreateWorkspaceForm (#394)", () => {
  it("creates a workspace with the chosen name, currency and time zone", async () => {
    const createWorkspace = vi.spyOn(workspacesApi, "createWorkspace").mockResolvedValue({
      id: "ws-1",
      name: "Personale",
      role: "owner",
      baseCurrency: "USD",
      timeZone: "America/New_York",
    });
    const { onCreated } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Personale" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "America/New_York" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    await waitFor(() =>
      expect(createWorkspace).toHaveBeenCalledWith("t", { name: "Personale", baseCurrency: "USD", timeZone: "America/New_York" }),
    );
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "ws-1" }));
  });

  it("shows an error and stays open when creation fails", async () => {
    vi.spyOn(workspacesApi, "createWorkspace").mockRejectedValue(new Error("500"));
    const { onCreated } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Personale" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("We could not create this workspace.");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("calls onClose when cancelled", () => {
    const { onClose } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
