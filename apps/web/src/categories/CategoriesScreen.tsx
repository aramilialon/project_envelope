import { useState, type FormEvent } from "react";
import { useIntl } from "react-intl";
import { useAuth } from "react-oidc-context";
import { useParams } from "react-router-dom";

import {
  archiveCategory,
  createCategory,
  createCategoryGroup,
  reorderCategories,
  reorderCategoryGroups,
  type Category,
  type CategoryGroup,
} from "./api.ts";
import { useCategories } from "./useCategories.ts";
import "./CategoriesScreen.css";

/** Swaps `ids[index]` with its nearest neighbour in `direction` that is not archived, skipping over archived slots so their own position never changes. Returns null at either end. */
function swapWithNeighbour(
  ids: readonly string[],
  archived: readonly boolean[],
  index: number,
  direction: -1 | 1,
): string[] | null {
  let neighbour = index + direction;
  while (neighbour >= 0 && neighbour < ids.length && archived[neighbour]) {
    neighbour += direction;
  }
  if (neighbour < 0 || neighbour >= ids.length) {
    return null;
  }
  const result = [...ids];
  const a = result[index]!;
  const b = result[neighbour]!;
  result[index] = b;
  result[neighbour] = a;
  return result;
}

/**
 * The "Categories" screen (#52), reached from "Workspace settings" in the workspace switcher:
 * every group and its categories, in order, with "+ Add group"/"+ Add category", "Archive" and
 * move up/down. No mockup draws this exact screen — `docs/ux/README.md` cites the budget
 * month's own table for where categories are *used*, but creating, archiving and reordering
 * them lives in `docs/ux/mockups/settings-first-run.html`'s workspace-settings "Categories"
 * tab instead (the same split already found for `#51`'s accounts screen). That mockup lets a
 * newly added group or category be renamed in place; `apps/api` has no rename endpoint, so the
 * name is asked for upfront instead, documented in the pull request. Archiving has no undo
 * (`apps/api`'s `archiveCategory`/`archiveCategoryGroup` are one-way), so archived categories
 * are listed read-only, the same way `#51`'s closed accounts are; a group itself is never
 * archived here, matching the mockup, which only offers to reorder a group, never retire one.
 */
export default function CategoriesScreen() {
  const intl = useIntl();
  const auth = useAuth();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const state = useCategories(workspaceId!);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [addingCategoryTo, setAddingCategoryTo] = useState<string | null>(null);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [busy, setBusy] = useState(false);

  if (state.status === "loading") {
    return (
      <p role="status">{intl.formatMessage({ id: "categories.loading", defaultMessage: "Loading your categories…" })}</p>
    );
  }

  if (state.status === "error") {
    return (
      <p role="alert">
        {intl.formatMessage({ id: "categories.error", defaultMessage: "We could not load your categories." })}
      </p>
    );
  }

  const { groups, categories, refetch } = state;
  const accessToken = auth.user?.access_token;
  const groupIds = groups.map((g) => g.id);
  const groupArchived = groups.map(() => false);

  function categoriesOf(groupId: string): Category[] {
    return categories.filter((c) => c.groupId === groupId);
  }

  async function moveGroup(groupId: string, direction: -1 | 1) {
    const index = groupIds.indexOf(groupId);
    const reordered = swapWithNeighbour(groupIds, groupArchived, index, direction);
    if (!accessToken || !reordered) {
      return;
    }
    setBusy(true);
    try {
      await reorderCategoryGroups(accessToken, workspaceId!, reordered);
      refetch();
    } finally {
      setBusy(false);
    }
  }

  async function moveCategory(group: CategoryGroup, categoryId: string, direction: -1 | 1) {
    const ids = categoriesOf(group.id).map((c) => c.id);
    const archived = categoriesOf(group.id).map((c) => c.archived);
    const index = ids.indexOf(categoryId);
    const reordered = swapWithNeighbour(ids, archived, index, direction);
    if (!accessToken || !reordered) {
      return;
    }
    setBusy(true);
    try {
      await reorderCategories(accessToken, workspaceId!, group.id, reordered);
      refetch();
    } finally {
      setBusy(false);
    }
  }

  async function handleArchiveCategory(categoryId: string) {
    if (!accessToken) {
      return;
    }
    setBusy(true);
    try {
      await archiveCategory(accessToken, workspaceId!, categoryId);
      refetch();
    } finally {
      setBusy(false);
    }
  }

  async function handleAddGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newGroupName.trim();
    if (!accessToken || !name) {
      return;
    }
    setBusy(true);
    try {
      await createCategoryGroup(accessToken, workspaceId!, name);
      setNewGroupName("");
      setAddingGroup(false);
      refetch();
    } finally {
      setBusy(false);
    }
  }

  async function handleAddCategory(event: FormEvent<HTMLFormElement>, groupId: string) {
    event.preventDefault();
    const name = newCategoryName.trim();
    if (!accessToken || !name) {
      return;
    }
    setBusy(true);
    try {
      await createCategory(accessToken, workspaceId!, groupId, name);
      setNewCategoryName("");
      setAddingCategoryTo(null);
      refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="categories-screen">
      <h1>{intl.formatMessage({ id: "categories.title", defaultMessage: "Categories" })}</h1>

      {groups.map((group, groupIndex) => {
        const groupCategories = categoriesOf(group.id);
        const open = groupCategories.filter((c) => !c.archived);
        const archived = groupCategories.filter((c) => c.archived);

        return (
          <section className="group" key={group.id}>
            <div className="group-head">
              <h2>{group.name}</h2>
              <div className="movers">
                <button
                  type="button"
                  className="ib"
                  aria-label={intl.formatMessage(
                    { id: "categories.group.moveUp", defaultMessage: "Move {name} up" },
                    { name: group.name },
                  )}
                  disabled={busy || groupIndex === 0}
                  onClick={() => void moveGroup(group.id, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="ib"
                  aria-label={intl.formatMessage(
                    { id: "categories.group.moveDown", defaultMessage: "Move {name} down" },
                    { name: group.name },
                  )}
                  disabled={busy || groupIndex === groups.length - 1}
                  onClick={() => void moveGroup(group.id, 1)}
                >
                  ↓
                </button>
              </div>
            </div>

            <ul className="category-list">
              {open.map((category, categoryIndex) => (
                <li key={category.id}>
                  <span className="name">{category.name}</span>
                  <div className="movers">
                    <button
                      type="button"
                      className="ib"
                      aria-label={intl.formatMessage(
                        { id: "categories.category.moveUp", defaultMessage: "Move {name} up" },
                        { name: category.name },
                      )}
                      disabled={busy || categoryIndex === 0}
                      onClick={() => void moveCategory(group, category.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="ib"
                      aria-label={intl.formatMessage(
                        { id: "categories.category.moveDown", defaultMessage: "Move {name} down" },
                        { name: category.name },
                      )}
                      disabled={busy || categoryIndex === open.length - 1}
                      onClick={() => void moveCategory(group, category.id, 1)}
                    >
                      ↓
                    </button>
                  </div>
                  <button
                    type="button"
                    className="plain danger"
                    disabled={busy}
                    onClick={() => void handleArchiveCategory(category.id)}
                  >
                    {intl.formatMessage({ id: "categories.category.archive", defaultMessage: "Archive" })}
                  </button>
                </li>
              ))}
            </ul>

            {archived.length > 0 && (
              <ul className="category-list archived">
                {archived.map((category) => (
                  <li key={category.id}>
                    <span className="name">{category.name}</span>
                    <span className="tag">
                      {intl.formatMessage({ id: "categories.category.archived", defaultMessage: "Archived" })}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {addingCategoryTo === group.id ? (
              <form className="inline-add" onSubmit={(event) => void handleAddCategory(event, group.id)}>
                <label className="sr-only" htmlFor={`new-category-${group.id}`}>
                  {intl.formatMessage({ id: "categories.category.name", defaultMessage: "Category name" })}
                </label>
                <input
                  id={`new-category-${group.id}`}
                  type="text"
                  value={newCategoryName}
                  onChange={(event) => setNewCategoryName(event.target.value)}
                  autoFocus
                  required
                />
                <button type="submit" className="plain" disabled={busy}>
                  {intl.formatMessage({ id: "common.action.add", defaultMessage: "Add" })}
                </button>
                <button
                  type="button"
                  className="plain"
                  onClick={() => {
                    setAddingCategoryTo(null);
                    setNewCategoryName("");
                  }}
                >
                  {intl.formatMessage({ id: "common.action.cancel", defaultMessage: "Cancel" })}
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="plain"
                onClick={() => {
                  setAddingCategoryTo(group.id);
                  setNewCategoryName("");
                }}
              >
                {intl.formatMessage({ id: "categories.category.add", defaultMessage: "+ Add a category" })}
              </button>
            )}
          </section>
        );
      })}

      {addingGroup ? (
        <form className="inline-add" onSubmit={(event) => void handleAddGroup(event)}>
          <label className="sr-only" htmlFor="new-group-name">
            {intl.formatMessage({ id: "categories.group.name", defaultMessage: "Group name" })}
          </label>
          <input
            id="new-group-name"
            type="text"
            value={newGroupName}
            onChange={(event) => setNewGroupName(event.target.value)}
            autoFocus
            required
          />
          <button type="submit" className="plain" disabled={busy}>
            {intl.formatMessage({ id: "common.action.add", defaultMessage: "Add" })}
          </button>
          <button
            type="button"
            className="plain"
            onClick={() => {
              setAddingGroup(false);
              setNewGroupName("");
            }}
          >
            {intl.formatMessage({ id: "common.action.cancel", defaultMessage: "Cancel" })}
          </button>
        </form>
      ) : (
        <button type="button" className="plain" onClick={() => setAddingGroup(true)}>
          {intl.formatMessage({ id: "categories.group.add", defaultMessage: "+ Add a group" })}
        </button>
      )}
    </div>
  );
}
