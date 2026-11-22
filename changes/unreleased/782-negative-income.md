Fixed

- `@envelope/core`: negative income in a later month (money going out of Unassigned, such as an
  overdraft recorded there) was charged back to every earlier month as money "assigned to later
  months" (`#782`). It now counts from its own month on: with €100 unassigned in September and a
  −€300 overdraft recorded on 22 November, September and October show €100 and November −€200,
  instead of −€200 in all three.
