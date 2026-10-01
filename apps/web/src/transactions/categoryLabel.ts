import type { Category } from "../categories/api.ts";

/** A split's own category name, or "Unassigned" for the null category income uses (#54). */
export function categoryLabel(categoryId: string | null, categories: readonly Category[], unassignedLabel: string): string {
  if (categoryId === null) {
    return unassignedLabel;
  }
  return categories.find((c) => c.id === categoryId)?.name ?? categoryId;
}
