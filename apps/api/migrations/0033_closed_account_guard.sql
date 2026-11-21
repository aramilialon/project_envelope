-- A closed account takes no writes (#729, ADR 0018; design.md, "Data model").
--
-- Closing an account (PATCH .../accounts/:accountId/close) needs it to be empty today and later.
-- Once closed, nothing may change what it holds: no transaction, split, trade, scheduled
-- transaction (or its splits) or reconciliation of it may be inserted, changed or deleted, whichever route, job or
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
-- The skip does not depend on the order a cascade runs in: when a workspace is deleted, its
-- accounts may already be gone when their rows are reached (the account is then not found, which
-- the check refuses, see below) or still be there, closed (refused as well); either way only the skip
-- lets the cascade through. The workspace-delete test in accounts/repository.test.ts fails without it.
-- The skip covers every nested trigger, not only a foreign key's action: a trigger added later
-- that writes one of these tables runs at depth 2 or more and passes unchecked, so it must check
-- the account itself (ADR 0018).
-- A SET NULL that passes this way: deleting one leg of a transfer on its own sets the other leg's
-- transfer_id to null even when that leg is on a closed account. No route deletes one leg alone
-- (deleting a transfer deletes both, and the leg's own delete is checked first), so the closed
-- account's balance cannot change through it.
-- The same holds for DELETE on accounts itself: deleting an account cascades to its rows at
-- depth 2. No route deletes an account (an account is closed, never deleted); whoever adds one
-- (#705) decides whether a closed account may be deleted.
--
-- The account a row is on now must be found, or the UPDATE or DELETE is refused: an existing
-- row's account always exists (its foreign key) and is in the row's own workspace, so not finding
-- it means the caller's policies hide it, and the write is never let through for want of a
-- closed_at to read. An account a row is moved to or inserted on that is not found is left to the
-- foreign key or the policy, which refuse it with their own errors.
--
-- Not SECURITY DEFINER: the account is read with the caller's own Row-Level Security, so an
-- account of another workspace is not found here and the foreign key or the policy refuses the
-- row instead. search_path is pinned so the names below always resolve to these tables.
CREATE FUNCTION refuse_closed_account_write() RETURNS trigger
SET search_path = public, pg_temp
AS $$
DECLARE
  -- UPDATE and DELETE: the account the row is on now (for a split, its parent's account).
  old_account uuid;
  -- Every account to lock: the one the row is on now and the one it will be on.
  account_ids uuid[];
  old_found boolean;
  closed boolean;
BEGIN
  IF TG_OP <> 'INSERT' AND pg_trigger_depth() > 1 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_TABLE_NAME = 'splits' THEN
    -- A split belongs to its transaction's account.
    IF TG_OP <> 'INSERT' THEN
      SELECT account_id INTO old_account FROM transactions WHERE id = OLD.transaction_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT array_agg(account_id) INTO account_ids FROM transactions WHERE id = NEW.transaction_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'scheduled_transaction_splits' THEN
    -- A scheduled split belongs to its scheduled transaction's account.
    IF TG_OP <> 'INSERT' THEN
      SELECT account_id INTO old_account FROM scheduled_transactions WHERE id = OLD.scheduled_transaction_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT array_agg(account_id) INTO account_ids FROM scheduled_transactions WHERE id = NEW.scheduled_transaction_id;
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      old_account := OLD.account_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      account_ids := ARRAY[NEW.account_id];
    END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    account_ids := array_append(account_ids, old_account);
  END IF;

  -- Every account is locked, open or closed, before closed_at is looked at: a WHERE on closed_at
  -- would leave an open account unlocked, and a close could then slip in before this write commits.
  SELECT bool_or(locked.id = old_account), bool_or(locked.closed_at IS NOT NULL) INTO old_found, closed
  FROM (SELECT id, closed_at FROM accounts WHERE id = ANY (account_ids) FOR KEY SHARE) AS locked;

  IF closed OR (TG_OP <> 'INSERT' AND old_found IS NOT TRUE) THEN
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

CREATE TRIGGER scheduled_transaction_splits_refuse_closed_account
  BEFORE INSERT OR UPDATE OR DELETE ON scheduled_transaction_splits
  FOR EACH ROW EXECUTE FUNCTION refuse_closed_account_write();

-- A reconciliation is only ever inserted on its own: the transactions it reconciles are checked
-- above, and marking one broken (an unlock) follows an update of a transaction, refused there.
CREATE TRIGGER reconciliations_refuse_closed_account
  BEFORE INSERT ON reconciliations
  FOR EACH ROW EXECUTE FUNCTION refuse_closed_account_write();
