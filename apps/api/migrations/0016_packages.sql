-- Prepaid daycare packages.
--  package_products: what the business sells (e.g. "10 full days", "10 half days"), with the
--    number of days, price and how long a package lasts after purchase (NULL = never expires).
--  customer_packages: a package sold to a customer, with the terms copied at the time of sale.
--    It's sold on an invoice; if that invoice is voided the package can't be used.
--  package_redemptions: one row per day of daycare paid for by a package. A redemption belongs to
--    the invoice line it zeroed; if that invoice is voided the day goes back on the package, and
--    if the draft line is deleted the redemption goes with it.
-- Remaining days are always computed (days - redemptions on invoices that aren't void).
CREATE TABLE package_products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  name                text NOT NULL CHECK (length(trim(name)) > 0),
  covers              text NOT NULL CHECK (covers IN ('full_day','half_day')),
  days                integer NOT NULL CHECK (days BETWEEN 1 AND 500),
  price_cents         bigint NOT NULL CHECK (price_cents >= 0),
  expires_after_days  integer CHECK (expires_after_days IS NULL OR expires_after_days BETWEEN 1 AND 3650),
  is_taxable          boolean NOT NULL DEFAULT false,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name)
);
CREATE TRIGGER package_products_updated_at BEFORE UPDATE ON package_products FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE customer_packages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  customer_id         uuid NOT NULL,
  product_id          uuid NOT NULL,
  name                text NOT NULL,
  covers              text NOT NULL CHECK (covers IN ('full_day','half_day')),
  days                integer NOT NULL CHECK (days >= 1),
  price_cents         bigint NOT NULL CHECK (price_cents >= 0),
  purchased_at        timestamptz NOT NULL DEFAULT now(),
  expires_on          date,
  invoice_id          uuid NOT NULL,
  sold_by_user_id     uuid NOT NULL REFERENCES users(id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id),
  FOREIGN KEY (organization_id, product_id) REFERENCES package_products(organization_id, id),
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id)
);
CREATE INDEX customer_packages_customer_idx ON customer_packages (customer_id);

CREATE TABLE package_redemptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  customer_package_id  uuid NOT NULL,
  invoice_id           uuid NOT NULL,
  invoice_line_id      uuid NOT NULL REFERENCES invoice_lines(id) ON DELETE CASCADE,
  reservation_id       uuid,
  used_on              date NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, customer_package_id) REFERENCES customer_packages(organization_id, id),
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id),
  FOREIGN KEY (organization_id, reservation_id) REFERENCES reservations(organization_id, id)
);
CREATE INDEX package_redemptions_package_idx ON package_redemptions (customer_package_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['package_products','customer_packages','package_redemptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON package_products TO {{app_role}};
GRANT SELECT, INSERT ON customer_packages, package_redemptions TO {{app_role}};
