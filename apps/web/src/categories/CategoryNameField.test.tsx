import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import { CategoryConflictError } from "./api.ts";
import CategoryNameField from "./CategoryNameField.tsx";

function renderField(props: Partial<Parameters<typeof CategoryNameField>[0]> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn().mockResolvedValue(undefined);
  const onCancel = props.onCancel ?? vi.fn();
  renderWithIntl(
    <CategoryNameField kind="category" label="Name of the new category in Home" submitLabel="Add" {...props} onSubmit={onSubmit} onCancel={onCancel} />,
  );
  return { onSubmit, onCancel, input: screen.getByLabelText("Name of the new category in Home") as HTMLInputElement };
}

describe("CategoryNameField (#397)", () => {
  it("opens focused, with an existing name selected for a rename", () => {
    const { input } = renderField({ initialValue: "Groceries", submitLabel: "Save" });

    expect(input).toHaveFocus();
    expect(input.value).toBe("Groceries");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Groceries".length);
  });

  it("saves the trimmed name on Enter", async () => {
    const { onSubmit, input } = renderField();

    fireEvent.change(input, { target: { value: "  Pharmacy " } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Pharmacy"));
  });

  it("never sends an empty name, saying why instead", () => {
    const { onSubmit, input } = renderField();

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);

    expect(screen.getByRole("alert")).toHaveTextContent("Type a name.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("names a duplicate within the group, keeping what was typed", async () => {
    const { input } = renderField({ onSubmit: vi.fn().mockRejectedValue(new CategoryConflictError("name_taken")) });

    fireEvent.change(input, { target: { value: "Groceries" } });
    fireEvent.submit(input.closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent("Another category in this group already has this name.");
    expect(input.value).toBe("Groceries");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("names a duplicate group as one", async () => {
    const { input } = renderField({ kind: "group", onSubmit: vi.fn().mockRejectedValue(new CategoryConflictError("name_taken")) });

    fireEvent.change(input, { target: { value: "Home" } });
    fireEvent.submit(input.closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent("Another group already has this name.");
  });

  it("explains the protected payment category and group, and any other failure", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new CategoryConflictError("payment_category"))
      .mockRejectedValueOnce(new CategoryConflictError("payment_group"))
      .mockRejectedValueOnce(new Error("PATCH failed: 500"));
    const { input } = renderField({ onSubmit, initialValue: "Visa" });
    const form = input.closest("form")!;

    fireEvent.submit(form);
    expect(await screen.findByText("A card's payment category is named after its card.")).toBeInTheDocument();
    fireEvent.submit(form);
    expect(await screen.findByText("The credit card payments group keeps its own name.")).toBeInTheDocument();
    fireEvent.submit(form);
    expect(await screen.findByText("We could not save this name.")).toBeInTheDocument();
  });

  it("empties itself for the next one when it stays open", async () => {
    const { onSubmit, input } = renderField({ stayOpen: true });

    fireEvent.change(input, { target: { value: "Pharmacy" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Pharmacy"));
    await waitFor(() => expect(input.value).toBe(""));
    expect(input).toHaveFocus();
  });

  it("cancels on Escape and on its own button", () => {
    const { onCancel, input } = renderField();

    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
