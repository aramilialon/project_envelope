Fixed

- `packages/core`: when one card pays another card's debt, the money set aside now follows the debt, from the
  card that was paid to the card that was charged, up to what the paid card holds beyond what it still owes;
  before, it moved the other way and the charged card could be asked for money that was already set aside
  (`#732`).
