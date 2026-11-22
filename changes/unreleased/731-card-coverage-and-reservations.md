Fixed

- `packages/core`, `apps/web`: a category overspent with a card and short of money for its scheduled
  transactions now asks for both in its "To do" item, and the card asks that much less, saying how much of its
  debt is asked on which category; when one category spent on two cards, the money assigned to it goes first
  to the card that still needs it, and the category's card line names the card still uncovered (`#731`).
