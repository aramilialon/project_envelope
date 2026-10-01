import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
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

  it("focuses the first focusable field on open", () => {
    renderWithIntl(
      <SideSheet title="Add account" onClose={vi.fn()}>
        <label htmlFor="name">
          Name
          <input id="name" />
        </label>
      </SideSheet>,
    );

    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  it("focuses the title when there is no focusable field", () => {
    renderWithIntl(
      <SideSheet title="Add account" onClose={vi.fn()}>
        <p>Nothing to focus here</p>
      </SideSheet>,
    );

    expect(screen.getByRole("heading", { name: "Add account" })).toHaveFocus();
  });

  it("traps Tab within the sheet", () => {
    renderWithIntl(
      <SideSheet title="Add account" onClose={vi.fn()}>
        <label htmlFor="name2">
          Name
          <input id="name2" />
        </label>
      </SideSheet>,
    );

    const closeButton = screen.getByRole("button", { name: "× Close" });
    const nameField = screen.getByLabelText("Name");

    // Tab forward from the last focusable control (the field) wraps to the first (close).
    nameField.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    // Shift+Tab back from the first control wraps to the last.
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(nameField).toHaveFocus();
  });

  it("restores focus to the triggering element on close", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open && (
            <SideSheet title="Add account" onClose={() => setOpen(false)}>
              <p>Form</p>
            </SideSheet>
          )}
        </>
      );
    }
    renderWithIntl(<Host />);
    const openButton = screen.getByRole("button", { name: "Open" });
    openButton.focus();
    fireEvent.click(openButton);

    fireEvent.click(screen.getByRole("button", { name: "× Close" }));

    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
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
