import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import GroupMenu from "./GroupMenu.tsx";

function renderMenu(isPaymentGroup = false) {
  const handlers = { onAddCategory: vi.fn(), onRename: vi.fn(), onManage: vi.fn() };
  renderWithIntl(
    <>
      <GroupMenu groupName="Home" isPaymentGroup={isPaymentGroup} {...handlers} />
      <p>Elsewhere</p>
    </>,
  );
  return handlers;
}

describe("GroupMenu (#397)", () => {
  it("is one quiet button, closed until pressed", () => {
    renderMenu();

    const button = screen.getByRole("button", { name: "Actions for Home" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers adding a category, renaming the group, and Workspace settings for the rest", () => {
    const handlers = renderMenu();

    fireEvent.click(screen.getByRole("button", { name: "Actions for Home" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Add a category",
      "Rename group",
      "Reorder or archive… (Workspace settings)",
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Add a category" }));
    expect(handlers.onAddCategory).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Actions for Home" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename group" }));
    expect(handlers.onRename).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Actions for Home" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Reorder or archive/ }));
    expect(handlers.onManage).toHaveBeenCalledTimes(1);
  });

  it("offers only Workspace settings for the credit card payments group", () => {
    renderMenu(true);

    fireEvent.click(screen.getByRole("button", { name: "Actions for Home" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Reorder or archive… (Workspace settings)"]);
  });

  it("closes on Escape, giving focus back to its button, and on a click elsewhere", () => {
    renderMenu();
    const button = screen.getByRole("button", { name: "Actions for Home" });

    fireEvent.click(button);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveFocus();

    fireEvent.click(button);
    fireEvent.pointerDown(screen.getByText("Elsewhere"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
