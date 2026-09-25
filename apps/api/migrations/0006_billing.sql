-- Billing, part 1: tax settings, invoices, invoice lines, payments.
-- Non-destructive (adds columns with safe defaults: tax rate 0%, services not taxable).
--
-- Integrity rules enforced in the database, not just the API:
--   * Lines can only change while the invoice is a draft (trigger).
--   * Issuing assigns stored totals; the trigger recomputes them from the lines and refuses a
--     mismatch, and issued amounts/tax rate/customer can never change afterwards.
--   * Status only moves draft → issued → void or draft → void.
--   * Payments can only be recorded against issued invoices, for the invoice's customer.

ALTER TABLE locations ADD COLUMN tax_rate_bps integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000);
ALTER TABLE services ADD COLUMN is_taxable boolean NOT NULL DEFAULT false;

-- Gap-free invoice numbers per organization, assigned when an invoice is issued.
CREATE TABLE invoice_counters (
  organization_id  uuid PRIMARY KEY REFERENCES organizations(id),
  last_number      integer NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);

CREATE TABLE invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  location_id          uuid NOT NULL,
  customer_id          uuid NOT NULL,
  reservation_id       uuid,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','void')),
  number               integer CHECK (number > 0),
  tax_rate_bps         integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  subtotal_cents       bigint,
  discount_cents       bigint,
  tax_cents            bigint,
  total_cents          bigint,
  notes                text,
  created_by_user_id   uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  issued_at            timestamptz,
  issued_by_user_id    uuid REFERENCES users(id),
  voided_at            timestamptz,
  voided_by_user_id    uuid REFERENCES users(id),
  void_reason          text,
  CHECK ((number IS NULL) = (issued_at IS NULL)),
  CHECK ((issued_at IS NULL) = (issued_by_user_id IS NULL)),
  CHECK ((issued_at IS NULL) = (total_cents IS NULL)),
  CHECK (total_cents IS NULL OR (subtotal_cents >= 0 AND discount_cents >= 0 AND tax_cents >= 0
         AND total_cents = subtotal_cents - discount_cents + tax_cents)),
  CHECK (status <> 'issued' OR issued_at IS NOT NULL),
  CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (voided_by_user_id IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL)),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, customer_id),
  UNIQUE (organization_id, number),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id),
  FOREIGN KEY (organization_id, reservation_id, customer_id) REFERENCES reservations(organization_id, id, customer_id)
);
CREATE INDEX invoices_customer_idx ON invoices (organization_id, customer_id, created_at DESC);
CREATE INDEX invoices_status_idx ON invoices (organization_id, status, created_at DESC);
-- One live invoice per reservation.
CREATE UNIQUE INDEX invoices_reservation_key ON invoices (reservation_id) WHERE reservation_id IS NOT NULL AND status <> 'void';
CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  invoice_id        uuid NOT NULL,
  service_id        uuid,
  description       text NOT NULL CHECK (length(trim(description)) > 0),
  quantity          integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  unit_price_cents  bigint NOT NULL CHECK (unit_price_cents >= 0),
  discount_cents    bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  taxable           boolean NOT NULL,
  position          integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (discount_cents <= quantity * unit_price_cents),
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services(organization_id, id)
);
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id, position);

CREATE TABLE payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  customer_id          uuid NOT NULL,
  invoice_id           uuid NOT NULL,
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
  method               text NOT NULL CHECK (method IN ('card','cash','check','other')),
  reference            text,
  received_at          timestamptz NOT NULL,
  recorded_by_user_id  uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  voided_at            timestamptz,
  voided_by_user_id    uuid REFERENCES users(id),
  void_reason          text,
  CHECK ((voided_at IS NULL) = (voided_by_user_id IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL)),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, invoice_id, customer_id) REFERENCES invoices(organization_id, id, customer_id)
);
CREATE INDEX payments_invoice_idx ON payments (invoice_id) WHERE voided_at IS NULL;
CREATE INDEX payments_customer_idx ON payments (organization_id, customer_id, received_at DESC);

-- ---------------------------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION invoice_lines_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF s IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'invoice lines can only change while the invoice is a draft' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER invoice_lines_draft_only BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_draft_only();

CREATE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_subtotal bigint; v_discount bigint; v_taxable bigint;
BEGIN
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'a void invoice cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'an issued invoice cannot return to draft' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
    OR NEW.tax_rate_bps IS DISTINCT FROM OLD.tax_rate_bps OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents OR NEW.discount_cents IS DISTINCT FROM OLD.discount_cents
    OR NEW.tax_cents IS DISTINCT FROM OLD.tax_cents OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at) THEN
    RAISE EXCEPTION 'an issued invoice cannot be changed; void it instead' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'issued' AND OLD.status = 'draft' THEN
    SELECT COALESCE(sum(quantity * unit_price_cents), 0), COALESCE(sum(discount_cents), 0),
           COALESCE(sum(quantity * unit_price_cents - discount_cents) FILTER (WHERE taxable), 0)
      INTO v_subtotal, v_discount, v_taxable FROM invoice_lines WHERE invoice_id = NEW.id;
    IF v_subtotal = 0 AND NOT EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = NEW.id) THEN
      RAISE EXCEPTION 'an invoice needs at least one line before it is issued' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.subtotal_cents IS DISTINCT FROM v_subtotal OR NEW.discount_cents IS DISTINCT FROM v_discount
       OR NEW.tax_cents IS DISTINCT FROM round(v_taxable * NEW.tax_rate_bps / 10000.0)::bigint THEN
      RAISE EXCEPTION 'invoice totals do not match its lines' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_guard BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_guard();

CREATE FUNCTION payments_issued_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM invoices WHERE id = NEW.invoice_id) IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'payments can only be recorded against an issued invoice' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_issued_only BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION payments_issued_only();

-- ---------------------------------------------------------------------------------------------
-- Row-level security and least-privilege grants
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice_counters','invoices','invoice_lines','payments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (organization_id = current_org_id())
                    WITH CHECK (organization_id = current_org_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON invoice_counters TO {{app_role}};
GRANT SELECT, INSERT ON invoices TO {{app_role}};
GRANT UPDATE (status, number, tax_rate_bps, subtotal_cents, discount_cents, tax_cents, total_cents, notes,
              issued_at, issued_by_user_id, voided_at, voided_by_user_id, void_reason, updated_at) ON invoices TO {{app_role}};
-- Draft lines may be removed; the trigger refuses it once issued.
GRANT SELECT, INSERT, DELETE ON invoice_lines TO {{app_role}};
GRANT SELECT, INSERT ON payments TO {{app_role}};
GRANT UPDATE (voided_at, voided_by_user_id, void_reason) ON payments TO {{app_role}};
GRANT UPDATE (tax_rate_bps) ON locations TO {{app_role}};
