import { MAX_AMOUNT_CENTS } from "@envelope/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../apiFetch.ts";
import { AMOUNT_TOO_LARGE_EUR, renderWithIntl } from "../test-utils.tsx";
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

  describe("never keeps a stale value (#698)", () => {
    function renderControlled(assigned: number, createImpl?: () => Promise<void>, currency = "EUR") {
      useAuth.mockReturnValue({ user: { access_token: "t" } });
      const createAssignments = vi.spyOn(budgetApi, "createAssignments").mockImplementation(createImpl ?? (() => Promise.resolve()));
      const onChanged = vi.fn();
      const onRename = vi.fn(() => Promise.resolve());
      const ui = (value: number) => (
        <IntlProvider locale="en" defaultLocale="en" messages={{}}>
          <RowDetail
            workspaceId="ws-1"
            month="2026-10"
            categoryId="cat-1"
            categoryName="Groceries"
            assigned={value}
            currency={currency}
            onClose={vi.fn()}
            onChanged={onChanged}
            onMoveMoney={vi.fn()}
            onRename={onRename}
          />
        </IntlProvider>
      );
      const { rerender } = render(ui(assigned));
      return { createAssignments, onChanged, rerender: (value: number) => rerender(ui(value)) };
    }

    it("shows the new assigned amount after a commit, so a second Enter does not apply a relative entry again", async () => {
      const { createAssignments, onChanged } = renderControlled(200_000);
      const input = focusedInput();

      fireEvent.change(input, { target: { value: "-1500" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(input).toHaveValue("500.00"));
      expect(onChanged).toHaveBeenCalledTimes(1);

      // The refetch has not come back yet: the field is still measured against what it just wrote.
      input.focus();
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(input).toHaveValue("500.00"));
      expect(createAssignments).toHaveBeenCalledTimes(1);
      expect(createAssignments).toHaveBeenCalledWith("t", "ws-1", [
        { month: "2026-10", sourceCategoryId: "cat-1", destinationCategoryId: null, amountCents: 150_000 },
      ]);
    });

    it("sends nothing on a second Enter while the first commit is still in flight", async () => {
      let finish: () => void = () => {};
      const { createAssignments } = renderControlled(
        60_000,
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const input = focusedInput();

      fireEvent.change(input, { target: { value: "+20" } });
      fireEvent.keyDown(input, { key: "Enter" });
      input.focus();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(createAssignments).toHaveBeenCalledTimes(1);

      finish();
      await waitFor(() => expect(input).toHaveValue("620.00"));
      expect(createAssignments).toHaveBeenCalledTimes(1);
    });

    it("follows a new assigned amount from the budget month", () => {
      const { rerender } = renderControlled(60_000);
      expect(screen.getByLabelText("Assigned this month")).toHaveValue("600.00");
      rerender(75_000);
      expect(screen.getByLabelText("Assigned this month")).toHaveValue("750.00");
    });

    it("keeps a rename in progress when the assigned amount changes underneath it", () => {
      const { rerender } = renderControlled(60_000);
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
      fireEvent.change(screen.getByLabelText("New name for the category"), { target: { value: "Food" } });

      rerender(75_000);

      expect(screen.getByLabelText("New name for the category")).toHaveValue("Food");
      expect(screen.getByLabelText("Assigned this month")).toHaveValue("750.00");
    });

    it("refuses an absolute amount above the cap with the cap message, sending nothing", async () => {
      const { createAssignments } = renderControlled(60_000);
      const input = focusedInput();

      fireEvent.change(input, { target: { value: "10000000000.01" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByRole("alert")).toHaveTextContent(AMOUNT_TOO_LARGE_EUR);
      expect(input).toHaveValue("10000000000.01");
      expect(createAssignments).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: "700" } });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("refuses a small relative entry whose result is above the cap", async () => {
      const { createAssignments } = renderControlled(MAX_AMOUNT_CENTS);
      const input = focusedInput();

      fireEvent.change(input, { target: { value: "+0.01" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByRole("alert")).toHaveTextContent(AMOUNT_TOO_LARGE_EUR);
      expect(createAssignments).not.toHaveBeenCalled();
    });

    it("keeps an entry being typed when a refetch brings a new assigned amount, and measures it against the new one", async () => {
      const { createAssignments, rerender } = renderControlled(60_000);
      const input = focusedInput();

      fireEvent.change(input, { target: { value: "800" } });
      rerender(75_000);
      expect(input).toHaveValue("800");

      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(createAssignments).toHaveBeenCalledWith("t", "ws-1", [
          { month: "2026-10", sourceCategoryId: null, destinationCategoryId: "cat-1", amountCents: 5_000 },
        ]),
      );
    });

    it("follows a refetch while focused when nothing has been typed", () => {
      const { rerender } = renderControlled(60_000);
      const input = focusedInput();
      rerender(75_000);
      expect(input).toHaveValue("750.00");
    });

    it("marks the field invalid, names the cap message and keeps the focus when Enter is refused for the cap", async () => {
      renderControlled(60_000);
      const input = focusedInput();
      expect(input).toHaveAttribute("aria-invalid", "false");

      fireEvent.change(input, { target: { value: "10000000000.01" } });
      fireEvent.keyDown(input, { key: "Enter" });

      const alert = await screen.findByRole("alert");
      expect(alert.id).not.toBe("");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input.getAttribute("aria-describedby")?.split(" ")).toEqual(["asg-h-cat-1", alert.id]);
      expect(input).toHaveFocus();
    });

    it("returns the focus to the field when the API refuses an Enter for the cap", async () => {
      renderControlled(60_000, () => Promise.reject(new ApiError("failed", 400, "amount_too_large", { max: MAX_AMOUNT_CENTS })));
      const input = focusedInput();

      fireEvent.change(input, { target: { value: "+20" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByRole("alert")).toBeInTheDocument();
      await waitFor(() => expect(input).toHaveFocus());
      expect(input).toHaveAttribute("aria-invalid", "true");
    });

    it("clears the cap message when a new assigned amount replaces the field", async () => {
      const { rerender } = renderControlled(60_000, () => Promise.reject(new ApiError("failed", 400, "amount_too_large", { max: MAX_AMOUNT_CENTS })));
      const input = focusedInput();

      fireEvent.change(input, { target: { value: "+20" } });
      input.blur();
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(input).not.toHaveFocus();

      rerender(75_000);
      expect(input).toHaveValue("750.00");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(input).toHaveAttribute("aria-invalid", "false");
    });

    it("shows and re-reads whole units for a currency without minor units (JPY)", async () => {
      const { createAssignments } = renderControlled(600, undefined, "JPY");
      const input = focusedInput();
      expect(input).toHaveValue("600");

      fireEvent.change(input, { target: { value: "650" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(input).toHaveValue("650"));
      expect(createAssignments).toHaveBeenCalledWith("t", "ws-1", [
        { month: "2026-10", sourceCategoryId: null, destinationCategoryId: "cat-1", amountCents: 50 },
      ]);

      // The amount shown after the commit reads back as the same amount: Enter sends nothing more.
      input.focus();
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(input).toHaveValue("650"));
      expect(createAssignments).toHaveBeenCalledTimes(1);
    });

    it("shows the cap message when the API refuses the amount as too large", async () => {
      renderControlled(60_000, () => Promise.reject(new ApiError("failed", 400, "amount_too_large", { max: MAX_AMOUNT_CENTS })));
      const input = focusedInput();

      fireEvent.change(input, { target: { value: "+20" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByRole("alert")).toHaveTextContent(AMOUNT_TOO_LARGE_EUR);
    });
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
