import type { IntlShape } from "react-intl";

/**
 * The sentence for the part of a card's debt asked on ordinary categories instead of on the card
 * (#731, `@envelope/core`'s `cardPartsAskedOnCategories`): one message, shared by the card's "To
 * do" item, its payment category detail and the Move money form, so the three read the same.
 */
export function cardPartAskedSentence(
  intl: IntlShape,
  money: (cents: number) => string,
  asked: readonly { readonly categoryId: string; readonly amountCents: number }[],
  categoryName: (id: string) => string,
): string {
  return intl.formatMessage(
    {
      id: "budget.todo.cardPartAskedOnCategories.sub",
      defaultMessage:
        "{count, plural, =1 {{amount} of the card's debt is included in what {category} still needs} other {{amount} of the card's debt is included in what # categories still need}}",
    },
    {
      count: asked.length,
      amount: money(asked.reduce((sum, p) => sum + p.amountCents, 0)),
      category: categoryName(asked[0]?.categoryId ?? ""),
    },
  );
}
