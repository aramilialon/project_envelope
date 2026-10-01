import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as categoriesApi from "./api.ts";
import type { Category, CategoryGroup } from "./api.ts";
import CategoriesScreen from "./CategoriesScreen.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

const HOME: CategoryGroup = { id: "g1", workspaceId: "ws-1", name: "Home", sortOrder: 1, archived: false };
const FUN: CategoryGroup = { id: "g2", workspaceId: "ws-1", name: "Fun", sortOrder: 2, archived: false };

function category(overrides: Partial<Category>): Category {
  return {
    id: "c1",
    workspaceId: "ws-1",
    groupId: "g1",
    name: "Groceries",
    sortOrder: 1,
    archived: false,
    ...overrides,
  };
}

function renderScreen(groups: CategoryGroup[], categories: Category[]) {
  useAuth.mockReturnValue({ user: { access_token: "t" } });
  vi.spyOn(categoriesApi, "listCategoryGroups").mockResolvedValue(groups);
  vi.spyOn(categoriesApi, "listCategories").mockResolvedValue(categories);
  return renderWithIntl(
    <MemoryRouter initialEntries={["/ws-1/settings/categories"]}>
      <Routes>
        <Route path="/:workspaceId/settings/categories" element={<CategoriesScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CategoriesScreen (#52)", () => {
  it("shows a loading state", () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(categoriesApi, "listCategoryGroups").mockReturnValue(new Promise(() => {}));
    vi.spyOn(categoriesApi, "listCategories").mockReturnValue(new Promise(() => {}));
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1/settings/categories"]}>
        <Routes>
          <Route path="/:workspaceId/settings/categories" element={<CategoriesScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading your categories…");
  });

  it("shows an error state", async () => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    vi.spyOn(categoriesApi, "listCategoryGroups").mockRejectedValue(new Error("network"));
    vi.spyOn(categoriesApi, "listCategories").mockResolvedValue([]);
    renderWithIntl(
      <MemoryRouter initialEntries={["/ws-1/settings/categories"]}>
        <Routes>
          <Route path="/:workspaceId/settings/categories" element={<CategoriesScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not load your categories.");
  });

  it("lists groups in order, each with its own categories", async () => {
    renderScreen(
      [HOME, FUN],
      [category({ id: "c1", groupId: "g1", name: "Groceries" }), category({ id: "c2", groupId: "g2", name: "Hobby" })],
    );

    expect(await screen.findByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Fun")).toBeInTheDocument();
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Hobby")).toBeInTheDocument();
  });

  it("disables moving the first group up and the last group down", async () => {
    renderScreen([HOME, FUN], []);
    await screen.findByText("Home");

    expect(screen.getByRole("button", { name: "Move Home up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Home down" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Fun up" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Fun down" })).toBeDisabled();
  });

  it("lists an archived category read-only, with no move or archive controls", async () => {
    renderScreen(
      [HOME],
      [
        category({ id: "c1", name: "Groceries" }),
        category({ id: "c2", name: "Old category", archived: true }),
      ],
    );

    expect(await screen.findByText("Old category")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Old category up" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Archive" })).toHaveLength(1);
  });

  it("archives a category and refreshes the list", async () => {
    const archiveCategory = vi.spyOn(categoriesApi, "archiveCategory").mockResolvedValue(category({ archived: true }));
    renderScreen([HOME], [category({ id: "c1", name: "Groceries" })]);
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(archiveCategory).toHaveBeenCalledWith("t", "ws-1", "c1"));
  });

  it("moves a category down, sending the whole group's id order including an archived one in between", async () => {
    const reorderCategories = vi.spyOn(categoriesApi, "reorderCategories").mockResolvedValue([]);
    renderScreen(
      [HOME],
      [
        category({ id: "c1", name: "Groceries", sortOrder: 1 }),
        category({ id: "c2", name: "Retired", sortOrder: 2, archived: true }),
        category({ id: "c3", name: "Restaurants", sortOrder: 3 }),
      ],
    );
    await screen.findByText("Groceries");

    fireEvent.click(screen.getByRole("button", { name: "Move Groceries down" }));

    await waitFor(() => expect(reorderCategories).toHaveBeenCalledWith("t", "ws-1", "g1", ["c3", "c2", "c1"]));
  });

  it("adds a new group from the inline form", async () => {
    const createCategoryGroup = vi
      .spyOn(categoriesApi, "createCategoryGroup")
      .mockResolvedValue({ ...HOME, id: "g3", name: "Savings" });
    renderScreen([HOME], []);
    await screen.findByText("Home");

    fireEvent.click(screen.getByRole("button", { name: "+ Add a group" }));
    fireEvent.change(screen.getByLabelText("Group name"), { target: { value: "Savings" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(createCategoryGroup).toHaveBeenCalledWith("t", "ws-1", "Savings"));
  });

  it("adds a new category to a group from its inline form", async () => {
    const createCategory = vi
      .spyOn(categoriesApi, "createCategory")
      .mockResolvedValue(category({ id: "c9", name: "Transport" }));
    renderScreen([HOME], []);
    await screen.findByText("Home");

    fireEvent.click(screen.getByRole("button", { name: "+ Add a category" }));
    fireEvent.change(screen.getByLabelText("Category name"), { target: { value: "Transport" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(createCategory).toHaveBeenCalledWith("t", "ws-1", "g1", "Transport"));
  });
});
