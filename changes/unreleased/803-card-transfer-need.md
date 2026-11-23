Fixed

- `packages/core`: when a category covers only part of its spending on several cards, the covered part no longer
  goes to a card that a card-to-card transfer is already paying enough into; it goes to a card that still needs
  money, so no card is left with something to cover while another holds more than it owes (`#803`).
