/**
 * Length limits for names and free text.
 *
 * Every name or free-text field a user can type is capped, so that one
 * member cannot store values close to the request body limit that every
 * other member's lists then carry. The length is counted in Unicode code
 * points, not UTF-16 code units: an emoji counts once, although JavaScript
 * stores it as two code units.
 */

import { ValidationError } from "./errors.ts";

/** Names: accounts, category groups, categories, workspaces. */
export const MAX_NAME_LENGTH = 100;

/** Longer free text: payees, memos, purposes. */
export const MAX_FREE_TEXT_LENGTH = 500;

/** The number of Unicode code points in `value`. */
export function textLength(value: string): number {
  let count = 0;
  for (const _ of value) {
    count++;
  }
  return count;
}

/**
 * @throws ValidationError with code "text_too_long" and details `{ field, max }`
 * when `value` has more than `max` code points.
 */
export function assertTextLength(value: string, max: number, field: string): void {
  if (textLength(value) > max) {
    throw new ValidationError("text_too_long", `${field} is longer than ${max} characters`, { field, max });
  }
}
