import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as workspacesApi from "./api.ts";
import DeleteWorkspaceForm from "./DeleteWorkspaceForm.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function renderForm(onDeleted = vi.fn(), onClose = vi.fn()) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  renderWithIntl(<DeleteWorkspaceForm workspaceId="ws-1" workspaceName="Famiglia" onClose={onClose} onDeleted={onDeleted} />);
  return { onDeleted, onClose };
}

describe("DeleteWorkspaceForm (#394)", () => {
  it("keeps the delete button disabled until the typed text matches the workspace's own name exactly", () => {
    renderForm();
    const confirmButton = screen.getByRole("button", { name: "Delete the workspace" });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("To confirm, type Famiglia"), { target: { value: "famiglia" } });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("To confirm, type Famiglia"), { target: { value: "Famiglia" } });
    expect(confirmButton).toBeEnabled();
  });

  it("deletes the workspace once confirmed", async () => {
    const deleteWorkspace = vi.spyOn(workspacesApi, "deleteWorkspace").mockResolvedValue(undefined);
    const { onDeleted } = renderForm();

    fireEvent.change(screen.getByLabelText("To confirm, type Famiglia"), { target: { value: "Famiglia" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete the workspace" }));

    await waitFor(() => expect(deleteWorkspace).toHaveBeenCalledWith("t", "ws-1"));
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it("shows an error and stays open when deletion fails", async () => {
    vi.spyOn(workspacesApi, "deleteWorkspace").mockRejectedValue(new Error("403"));
    const { onDeleted } = renderForm();

    fireEvent.change(screen.getByLabelText("To confirm, type Famiglia"), { target: { value: "Famiglia" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete the workspace" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("We could not delete this workspace.");
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("calls onClose when cancelled", () => {
    const { onClose } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
