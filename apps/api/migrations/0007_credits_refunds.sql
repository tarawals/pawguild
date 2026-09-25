-- Billing, part 2: credit notes, refunds, and customer account credit (deposits/prepayments).
-- Non-destructive. The payments.method check is widened to allow 'account_credit' (payments made
-- by applying the customer's account credit to an invoice).
--
-- Invoice balance = total - credit notes - (payments - refunds from that invoice).
-- A negative balance means the customer overpaid; it must be refunded or moved to account credit.
-- Account credit balance = sum of account_credits entries, and can never go negative (trigger).

ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('card','cash','check','other','account_credit'));

-- ---------------------------------------------------------------------------------------------
-- Credit notes: reduce what is owed on an issued invoice without changing the invoice.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE invoice_credit_notes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  invoice_id           uuid NOT NULL,
  customer_id          uuid NOT NULL,
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
  reason               text NOT NULL CHECK (length(trim(reason)) > 0),
  created_by_user_id   uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, invoice_id, customer_id) REFERENCES invoices(organization_id, id, customer_id)
);
CREATE INDEX invoice_credit_notes_invoice_idx ON invoice_credit_notes (invoice_id);

-- ---------------------------------------------------------------------------------------------
-- Refunds: money going back to the customer. From an invoice overpayment (invoice_id set), or from
-- account credit (invoice_id null). method 'account_credit' moves an invoice overpayment to credit.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE refunds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  customer_id          uuid NOT NULL,
  invoice_id           uuid,
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
  method               text NOT NULL CHECK (method IN ('card','cash','check','other','account_credit')),
  reference            text,
  reason               text NOT NULL CHECK (length(trim(reason)) > 0),
  refunded_at          timestamptz NOT NULL,
  recorded_by_user_id  uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (method <> 'account_credit' OR invoice_id IS NOT NULL),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id),
  FOREIGN KEY (organization_id, invoice_id, customer_id) REFERENCES invoices(organization_id, id, customer_id)
);
CREATE INDEX refunds_invoice_idx ON refunds (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX refunds_customer_idx ON refunds (organization_id, customer_id, refunded_at DESC);

-- ---------------------------------------------------------------------------------------------
-- Account credit ledger (signed amounts).
--   received      +  money taken on account (deposit or prepayment), with method
--   from_invoice  +  invoice overpayment moved to credit (linked refund with method account_credit)
--   reversal      +  a voided account-credit payment gives the credit back
--   applied       -  credit used to pay an invoice (linked payment with method account_credit)
--   refunded      -  credit paid back out to the customer (linked refund)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE account_credits (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  customer_id          uuid NOT NULL,
  amount_cents         bigint NOT NULL CHECK (amount_cents <> 0),
  kind                 text NOT NULL CHECK (kind IN ('received','from_invoice','reversal','applied','refunded')),
  method               text CHECK (method IS NULL OR method IN ('card','cash','check','other')),
  reference            text,
  note                 text,
  reservation_id       uuid,
  invoice_id           uuid,
  payment_id           uuid,
  refund_id            uuid,
  created_by_user_id   uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('received','from_invoice','reversal')) = (amount_cents > 0)),
  CHECK ((kind = 'received') = (method IS NOT NULL)),
  CHECK (kind <> 'applied' OR payment_id IS NOT NULL),
  CHECK (kind <> 'reversal' OR payment_id IS NOT NULL),
  CHECK (kind NOT IN ('from_invoice','refunded') OR refund_id IS NOT NULL),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id),
  FOREIGN KEY (organization_id, reservation_id, customer_id) REFERENCES reservations(organization_id, id, customer_id),
  FOREIGN KEY (organization_id, invoice_id, customer_id) REFERENCES invoices(organization_id, id, customer_id),
  FOREIGN KEY (organization_id, payment_id) REFERENCES payments(organization_id, id),
  FOREIGN KEY (organization_id, refund_id) REFERENCES refunds(organization_id, id)
);
CREATE INDEX account_credits_customer_idx ON account_credits (organization_id, customer_id, created_at DESC);
CREATE INDEX account_credits_reservation_idx ON account_credits (reservation_id) WHERE reservation_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION invoice_credit_notes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_total bigint; v_credited bigint;
BEGIN
  SELECT status, total_cents INTO v_status, v_total FROM invoices WHERE id = NEW.invoice_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'credit notes can only be added to an issued invoice' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_credited FROM invoice_credit_notes WHERE invoice_id = NEW.invoice_id;
  IF v_credited + NEW.amount_cents > v_total THEN
    RAISE EXCEPTION 'credit notes can''t exceed the invoice total' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_credit_notes_guard BEFORE INSERT ON invoice_credit_notes FOR EACH ROW EXECUTE FUNCTION invoice_credit_notes_guard();

-- An invoice refund can't exceed what the customer overpaid on that invoice.
CREATE FUNCTION refunds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_total bigint; v_credited bigint; v_paid bigint; v_refunded bigint;
BEGIN
  IF NEW.invoice_id IS NULL THEN RETURN NEW; END IF;
  SELECT status, total_cents INTO v_status, v_total FROM invoices WHERE id = NEW.invoice_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'refunds can only be made against an issued invoice' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_credited FROM invoice_credit_notes WHERE invoice_id = NEW.invoice_id;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_paid FROM payments WHERE invoice_id = NEW.invoice_id AND voided_at IS NULL;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_refunded FROM refunds WHERE invoice_id = NEW.invoice_id;
  IF NEW.amount_cents > (v_paid - v_refunded) - (v_total - v_credited) THEN
    RAISE EXCEPTION 'a refund can''t be more than the amount overpaid on the invoice' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_guard BEFORE INSERT ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_guard();

-- Account credit can never go negative for a customer.
CREATE FUNCTION account_credits_non_negative() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_balance bigint;
BEGIN
  PERFORM 1 FROM customers WHERE id = NEW.customer_id FOR UPDATE;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_balance FROM account_credits WHERE customer_id = NEW.customer_id;
  IF v_balance < 0 THEN
    RAISE EXCEPTION 'that is more than the customer''s available account credit' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER account_credits_non_negative AFTER INSERT ON account_credits
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION account_credits_non_negative();

-- ---------------------------------------------------------------------------------------------
-- RLS and grants: financial records are append-only for the application.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice_credit_notes','refunds','account_credits']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (organization_id = current_org_id())
                    WITH CHECK (organization_id = current_org_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON invoice_credit_notes, refunds, account_credits TO {{app_role}};
