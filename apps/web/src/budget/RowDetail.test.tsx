import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as budgetApi from "./api.ts";
import RowDetail from "./RowDetail.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

function renderRowDetail(assigned = 60_000) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  const createAssignments = vi.spyOn(budgetApi, "createAssignments").mockResolvedValue(undefined);
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const onMoveMoney = vi.fn();
  renderWithIntl(
    <RowDetail
      workspaceId="ws-1"
      month="2026-10"
      categoryId="cat-1"
      categoryName="Groceries"
      assigned={assigned}
      currency="EUR"
      onClose={onClose}
      onChanged={onChanged}
      onMoveMoney={onMoveMoney}
    />,
  );
  return { createAssignments, onClose, onChanged, onMoveMoney };
}

/** `.blur()` is a no-op in jsdom unless the element is actually focused first — `fireEvent.keyDown`/`.change` alone never focus it. */
function focusedInput(): HTMLElement {
  const input = screen.getByLabelText("Assigned this month");
  input.focus();
  return input;
}

describe("RowDetail (#327)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the current assigned amount, plain, no currency symbol", () => {
    renderRowDetail(60_000);
    expect(screen.getByLabelText("Assigned this month")).toHaveValue("600.00");
  });

  it("typing a new amount and pressing Enter commits the difference as one assignment", async () => {
    const { createAssignments, onChanged } = renderRowDetail(60_000);
    const input = focusedInput();

    fireEvent.change(input, { target: { value: "650.00" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(createAssignments).toHaveBeenCalledWith("t", "ws-1", [
        { month: "2026-10", sourceCategoryId: null, destinationCategoryId: "cat-1", amountCents: 5_000 },
      ]),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("a relative '+20' adds to the current assigned amount instead of replacing it", async () => {
    const { createAssignments } = renderRowDetail(60_000);
    const input = focusedInput();

    fireEvent.change(input, { target: { value: "+20" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(createAssignments).toHaveBeenCalledWith("t", "ws-1", [
        { month: "2026-10", sourceCategoryId: null, destinationCategoryId: "cat-1", amountCents: 2_000 },
      ]),
    );
  });

  it("a relative '-15' moves money back to unassigned instead of the category", async () => {
    const { createAssignments } = renderRowDetail(60_000);
    const input = focusedInput();

    fireEvent.change(input, { target: { value: "-15" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(createAssignments).toHaveBeenCalledWith("t", "ws-1", [
        { month: "2026-10", sourceCategoryId: "cat-1", destinationCategoryId: null, amountCents: 1_500 },
      ]),
    );
  });

  it("leaving the field (not just Enter) also commits", async () => {
    const { createAssignments } = renderRowDetail(60_000);
    const input = focusedInput();

    fireEvent.change(input, { target: { value: "700.00" } });
    fireEvent.blur(input);

    await waitFor(() => expect(createAssignments).toHaveBeenCalled());
  });

  it("Esc reverts the field without committing anything", async () => {
    const { createAssignments } = renderRowDetail(60_000);
    const input = focusedInput();

    fireEvent.change(input, { target: { value: "999.00" } });
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(input).toHaveValue("600.00"));
    expect(createAssignments).not.toHaveBeenCalled();
  });

  it("an unchanged amount commits nothing", async () => {
    const { createAssignments } = renderRowDetail(60_000);
    const input = focusedInput();

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input).toHaveValue("600.00"));
    expect(createAssignments).not.toHaveBeenCalled();
  });

  it("an unparseable amount is left as typed, not silently discarded", async () => {
    renderRowDetail(60_000);
    const input = focusedInput();

    fireEvent.change(input, { target: { value: "not a number" } });
    fireEvent.blur(input);

    await waitFor(() => expect(input).toHaveValue("not a number"));
  });

  it("the '× Close' button calls onClose", () => {
    const { onClose } = renderRowDetail(60_000);
    fireEvent.click(screen.getByRole("button", { name: "× Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("the 'Move money' button calls onMoveMoney", () => {
    const { onMoveMoney } = renderRowDetail(60_000);
    fireEvent.click(screen.getByRole("button", { name: "Move money" }));
    expect(onMoveMoney).toHaveBeenCalled();
  });
});
