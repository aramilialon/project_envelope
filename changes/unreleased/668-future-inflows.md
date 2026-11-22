Fixed

- `@envelope/core`, `apps/web`: money coming in with a category and dated after today (a refund, a
  categorized transfer in from an off-budget account, the positive split of a receipt with a
  return on it) counted in its category at once; it now counts nowhere until its date, split by
  split, like income, while spending still counts at once (`#668`). A €200 Groceries refund dated
  28 November leaves Groceries at €300 instead of €500 until the 28th; a card refund dated after
  today moves nothing between the category and the card's payment category until then. The
  transaction form says "The money comes into {category} on {date}." for such a transfer into a
  category instead of a from and to.
