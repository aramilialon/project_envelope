-- design.md's Data model treats an account's kind (checking, savings, cash,
-- credit_card) and whether it is on-budget as two independent dimensions;
-- 'off_budget' as a value of type conflated them. on_budget alone decides
-- that now (#11).
ALTER TABLE accounts DROP CONSTRAINT accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check
  CHECK (type IN ('checking', 'savings', 'cash', 'credit_card'));

-- The category that holds money set aside to pay an on-budget credit card
-- (packages/core's BudgetAccount.paymentCategoryId). Required when
-- type = 'credit_card' AND on_budget is an application-level invariant, not a
-- DB constraint: the repository creates and links this category atomically
-- with the account itself.
ALTER TABLE accounts ADD COLUMN payment_category_id uuid REFERENCES categories (id);
ALTER TABLE accounts ADD CONSTRAINT accounts_payment_category_type_check
  CHECK (payment_category_id IS NULL OR type = 'credit_card');
