Added

- `apps/api`: a workspace can record its own closing prices of an instrument, one date at a time
  or from a CSV file of dates and closes, list them next to the shared prices and delete them;
  a file is stored whole or refused at its first bad line, naming the line and the column (`#83`).
