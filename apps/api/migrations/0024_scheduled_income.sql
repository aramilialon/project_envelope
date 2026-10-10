-- Scheduled income (#347, design.md's "Scheduled" side sheet: "'Expected income' (income
-- reserves nothing and lands in unassigned money when recorded)"): a scheduled transaction's
-- single split can now have no category, the same convention a real transaction's own split
-- already uses for income (migration 0006). A multi-split scheduled transaction still always
-- needs a real category on every row — application code rejects income mixed into a split, the
-- same way `transactions/repository.ts` already does for real transactions.
ALTER TABLE scheduled_transaction_splits ALTER COLUMN category_id DROP NOT NULL;
