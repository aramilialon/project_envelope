import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as targetsApi from "./api.ts";
import type { GoalRecord } from "./api.ts";
import TargetEditor from "./TargetEditor.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function renderEditor(overrides: Partial<Parameters<typeof TargetEditor>[0]> = {}) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const rendered = renderWithIntl(
    <TargetEditor
      workspaceId="ws-1"
      categoryId="cat-1"
      categoryName="Groceries"
      month="2026-09"
      currency="EUR"
      state={{ carried: 0, assigned: 2000, available: 2000 }}
      onClose={onClose}
      onSaved={onSaved}
      {...overrides}
    />,
  );
  return { ...rendered, onClose, onSaved };
}

describe("TargetEditor (#55)", () => {
  it("shows a live preview as the amount changes, with no network call", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "60.00" } });

    expect(await screen.findByText(/Asks €60.00 this month/)).toBeInTheDocument();
  });

  it("shows the due month and interval fields only for the kinds that need them", () => {
    renderEditor();
    expect(screen.queryByLabelText("Due month")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Amount by a date/ }));
    expect(screen.getByLabelText("Due month")).toBeInTheDocument();
    expect(screen.queryByLabelText("Repeat interval")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Repeating expense/ }));
    expect(screen.getByLabelText("Due month")).toBeInTheDocument();
    expect(screen.getByLabelText("Repeat interval")).toBeInTheDocument();
  });

  it("requires a positive amount", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter an amount greater than zero.");
  });

  it("requires a due month for an amount-by-date target", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("radio", { name: /Amount by a date/ }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a due month.");
  });

  it("saves a monthly target", async () => {
    const upsertGoal = vi.spyOn(targetsApi, "upsertGoal").mockResolvedValue({} as GoalRecord);
    const { onSaved } = renderEditor();

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "60.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(upsertGoal).toHaveBeenCalledWith("t", "ws-1", "cat-1", { kind: "monthly", amountCents: 6000 }));
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("saves a repeating target with its due month and interval", async () => {
    const upsertGoal = vi.spyOn(targetsApi, "upsertGoal").mockResolvedValue({} as GoalRecord);
    renderEditor();

    fireEvent.click(screen.getByRole("radio", { name: /Repeating expense/ }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "180.00" } });
    fireEvent.change(screen.getByLabelText("Due month"), { target: { value: "2027-03" } });
    fireEvent.change(screen.getByLabelText("Repeat interval"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(upsertGoal).toHaveBeenCalledWith("t", "ws-1", "cat-1", {
        kind: "repeating",
        amountCents: 18000,
        dueMonth: "2027-03",
        every: 12,
      }),
    );
  });

  it("offers Remove only when editing an existing target, and calls deleteGoal", async () => {
    const deleteGoal = vi.spyOn(targetsApi, "deleteGoal").mockResolvedValue(undefined);
    const existing: GoalRecord = {
      id: "g1",
      workspaceId: "ws-1",
      categoryId: "cat-1",
      kind: "monthly",
      amountCents: 6000,
      dueMonth: null,
      every: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    const { onSaved } = renderEditor({ existing });

    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(deleteGoal).toHaveBeenCalledWith("t", "ws-1", "cat-1"));
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("omits Remove for a new target", () => {
    renderEditor();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });
});
