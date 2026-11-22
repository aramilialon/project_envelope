Fixed

- `apps/api`: a transaction on an off-budget account that is not a transfer no longer takes a
  category the budget would ignore: creating one with a category, editing its splits to give it
  one, confirming an import row with one or reconciling with a categorized adjustment answers
  400 `category_not_allowed` (`details.field` `categoryId`). Transfers keep their category on the
  on-budget leg (`#710`).
