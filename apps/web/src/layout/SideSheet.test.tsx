import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import SideSheet from "./SideSheet.tsx";

describe("SideSheet (#323)", () => {
  it("renders as a labelled dialog with its title and children", () => {
    renderWithIntl(
      <SideSheet title="Add account" onClose={vi.fn()}>
        <p>Form goes here</p>
      </SideSheet>,
    );

    const dialog = screen.getByRole("dialog", { name: "Add account" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Add account" })).toBeInTheDocument();
    expect(screen.getByText("Form goes here")).toBeInTheDocument();
  });

  it("closes on '× Close'", () => {
    const onClose = vi.fn();
    renderWithIntl(
      <SideSheet title="Add account" onClose={onClose}>
        <p>Form</p>
      </SideSheet>,
    );

    fireEvent.click(screen.getByRole("button", { name: "× Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Esc", () => {
    const onClose = vi.fn();
    renderWithIntl(
      <SideSheet title="Add account" onClose={onClose}>
        <p>Form</p>
      </SideSheet>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close on another key", () => {
    const onClose = vi.fn();
    renderWithIntl(
      <SideSheet title="Add account" onClose={onClose}>
        <p>Form</p>
      </SideSheet>,
    );

    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
