Fixed

- `packages/core`, `apps/web`, `apps/api`: a category overspent with a card and short of money for its
  scheduled transactions now asks for both in its "To do" item, and the card asks that much less, saying how
  much of its debt is included in what a category still needs; the card's "Assign" button, "Move money" and
  quick assign's "Cover the cards' debt" ask that same amount, so running quick assign's two cover modes in
  either order sets the money aside once; when one category spent on two cards, the money assigned to it goes
  first to the card that still needs it, and the category's card line names the card still uncovered (`#731`).
