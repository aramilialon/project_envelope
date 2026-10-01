import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as targetsApi from "./api.ts";
import QuickAssignPanel from "./QuickAssignPanel.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function renderPanel() {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  const onClose = vi.fn();
  const onDone = vi.fn();
  const rendered = renderWithIntl(
    <QuickAssignPanel
      workspaceId="ws-1"
      month="2026-09"
      groups={[
        { id: "g1", name: "Home" },
        { id: "g2", name: "Fun" },
      ]}
      onClose={onClose}
      onDone={onDone}
    />,
  );
  return { ...rendered, onClose, onDone };
}

describe("QuickAssignPanel (#55)", () => {
  it("runs with the default scope (all categories) and mode (fund the targets)", async () => {
    const runQuickAssign = vi.spyOn(targetsApi, "runQuickAssign").mockResolvedValue(undefined);
    const { onDone } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(runQuickAssign).toHaveBeenCalledWith("t", "ws-1", "2026-09", { kind: "all" }, "fund_targets"));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("runs scoped to one group with a different mode", async () => {
    const runQuickAssign = vi.spyOn(targetsApi, "runQuickAssign").mockResolvedValue(undefined);
    renderPanel();

    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "g2" } });
    fireEvent.click(screen.getByRole("radio", { name: "As spent last month" }));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() =>
      expect(runQuickAssign).toHaveBeenCalledWith("t", "ws-1", "2026-09", { kind: "group", groupId: "g2" }, "repeat_spent"),
    );
  });

  it("shows an error when the action fails", async () => {
    vi.spyOn(targetsApi, "runQuickAssign").mockRejectedValue(new Error("network"));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("We could not run quick assign.");
  });
});
