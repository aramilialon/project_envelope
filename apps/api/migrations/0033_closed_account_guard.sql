-- A closed account takes no writes (#729, ADR 0018; design.md, "Data model").
--
-- Closing an account (PATCH .../accounts/:accountId/close) needs it to be empty today and later.
-- Once closed, nothing may change what it holds: no transaction, split, trade, scheduled
-- transaction or reconciliation of it may be inserted, changed or deleted, whichever route, job or
-- sync change writes it. The rule lives here, in one trigger function, rather than in each
-- repository, so a write path added later cannot forget it.
--
-- The function locks each account it reads FOR KEY SHARE. Closing reads the account FOR UPDATE
-- (accounts/repository.ts, closeAccount), which conflicts with it, so a write and a close of the
-- same account never overlap: a write that locked first is committed (or rolled back) before the
-- close checks what the account holds, and a write that comes after the close sees closed_at.
-- FOR KEY SHARE does not conflict with itself or with an UPDATE that leaves the key alone, so
-- writes to the same open account do not wait for one another.
--
-- A refusal is a check_violation naming the constraint `account_closed`, as for the rules of
-- migration 0028; the API answers it 409 `account_closed` (errors.ts, toErrorReply).
--
-- Only a statement's own writes are checked (pg_trigger_depth() = 1). An UPDATE or DELETE fired
-- by a foreign key's action (ON DELETE CASCADE, SET NULL, ON UPDATE CASCADE) comes from a write
-- that was itself checked, or from deleting a workspace, which must remove everything in it,
-- closed accounts included. An INSERT is always checked: no foreign key action inserts.
--
-- Not SECURITY DEFINER: the account is read with the caller's own Row-Level Security, so an
-- account of another workspace is not found here and the foreign key or the policy refuses the
-- row instead. search_path is pinned so the names below always resolve to these tables.
CREATE FUNCTION refuse_closed_account_write() RETURNS trigger
SET search_path = public, pg_temp
AS $$
DECLARE
  account_ids uuid[];
  closed boolean;
BEGIN
  IF TG_OP <> 'INSERT' AND pg_trigger_depth() > 1 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_TABLE_NAME = 'splits' THEN
    -- A split belongs to its transaction's account.
    IF TG_OP = 'INSERT' THEN
      SELECT array_agg(account_id) INTO account_ids FROM transactions WHERE id = NEW.transaction_id;
    ELSIF TG_OP = 'UPDATE' THEN
      SELECT array_agg(account_id) INTO account_ids FROM transactions WHERE id IN (OLD.transaction_id, NEW.transaction_id);
    ELSE
      SELECT array_agg(account_id) INTO account_ids FROM transactions WHERE id = OLD.transaction_id;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    account_ids := ARRAY[NEW.account_id];
  ELSIF TG_OP = 'UPDATE' THEN
    account_ids := ARRAY[OLD.account_id, NEW.account_id];
  ELSE
    account_ids := ARRAY[OLD.account_id];
  END IF;

  -- Every account is locked, open or closed, before closed_at is looked at: a WHERE on closed_at
  -- would leave an open account unlocked, and a close could then slip in before this write commits.
  SELECT bool_or(locked.closed_at IS NOT NULL) INTO closed
  FROM (SELECT closed_at FROM accounts WHERE id = ANY (account_ids) FOR KEY SHARE) AS locked;

  IF closed THEN
    RAISE EXCEPTION 'the account is closed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_closed';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_refuse_closed_account
  BEFORE INSERT OR UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION refuse_closed_account_write();

CREATE TRIGGER splits_refuse_closed_account
  BEFORE INSERT OR UPDATE OR DELETE ON splits
  FOR EACH ROW EXECUTE FUNCTION refuse_closed_account_write();

CREATE TRIGGER trades_refuse_closed_account
  BEFORE INSERT OR UPDATE OR DELETE ON trades
  FOR EACH ROW EXECUTE FUNCTION refuse_closed_account_write();

CREATE TRIGGER scheduled_transactions_refuse_closed_account
  BEFORE INSERT OR UPDATE OR DELETE ON scheduled_transactions
  FOR EACH ROW EXECUTE FUNCTION refuse_closed_account_write();

-- A reconciliation is only ever inserted on its own: the transactions it reconciles are checked
-- above, and marking one broken (an unlock) follows an update of a transaction, refused there.
CREATE TRIGGER reconciliations_refuse_closed_account
  BEFORE INSERT ON reconciliations
  FOR EACH ROW EXECUTE FUNCTION refuse_closed_account_write();
