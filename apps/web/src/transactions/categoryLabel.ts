import type { Category } from "../categories/api.ts";

/** Builds the lookup `categoryLabel` needs, once per category list instead of once per split. */
export function buildCategoryNameById(categories: readonly Category[]): ReadonlyMap<string, string> {
  return new Map(categories.map((c) => [c.id, c.name] as const));
}

/** A split's own category name, or "Unassigned" for the null category income uses (#54). */
export function categoryLabel(categoryId: string | null, categoryNameById: ReadonlyMap<string, string>, unassignedLabel: string): string {
  if (categoryId === null) {
    return unassignedLabel;
  }
  return categoryNameById.get(categoryId) ?? categoryId;
}
