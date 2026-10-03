-- Memberships: a monthly fee that includes a number of full or half days of daycare.
--  membership_plans: what's offered (name, days per month, monthly price).
--  customer_memberships: a sign-up, with the plan's terms copied. It bills on the sign-up date and
--    then on the same day each month (the last day of shorter months), at full price (no
--    proration). Cancelling sets ends_on to the last day of the paid month.
--  membership_periods: one row per billed month, with its issued invoice. Included days can only be
--    used for daycare on dates inside the period, and unused days don't roll over. A period whose
--    invoice is voided can't be used.
-- Days used are recorded in package_redemptions (now either a package or a membership period).
CREATE TABLE membership_plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  name              text NOT NULL CHECK (length(trim(name)) > 0),
  covers            text NOT NULL CHECK (covers IN ('full_day','half_day')),
  days_per_month    integer NOT NULL CHECK (days_per_month BETWEEN 1 AND 31),
  price_cents       bigint NOT NULL CHECK (price_cents >= 0),
  is_taxable        boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name)
);
CREATE TRIGGER membership_plans_updated_at BEFORE UPDATE ON membership_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE customer_memberships (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  customer_id         uuid NOT NULL,
  plan_id             uuid NOT NULL,
  location_id         uuid NOT NULL,
  name                text NOT NULL,
  covers              text NOT NULL CHECK (covers IN ('full_day','half_day')),
  days_per_month      integer NOT NULL CHECK (days_per_month >= 1),
  price_cents         bigint NOT NULL CHECK (price_cents >= 0),
  is_taxable          boolean NOT NULL,
  started_on          date NOT NULL,
  ends_on             date,
  cancelled_at        timestamptz,
  cancelled_by_user_id uuid REFERENCES users(id),
  cancel_reason       text,
  created_by_user_id  uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= started_on),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id),
  FOREIGN KEY (organization_id, plan_id) REFERENCES membership_plans(organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id)
);
CREATE INDEX customer_memberships_customer_idx ON customer_memberships (customer_id);

CREATE TABLE membership_periods (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id),
  customer_membership_id   uuid NOT NULL,
  period_start             date NOT NULL,
  period_end               date NOT NULL,
  days                     integer NOT NULL CHECK (days >= 1),
  invoice_id               uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  UNIQUE (customer_membership_id, period_start),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_membership_id) REFERENCES customer_memberships(organization_id, id),
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id)
);

ALTER TABLE package_redemptions ALTER COLUMN customer_package_id DROP NOT NULL;
ALTER TABLE package_redemptions ADD COLUMN membership_period_id uuid;
ALTER TABLE package_redemptions ADD CONSTRAINT package_redemptions_period_fk
  FOREIGN KEY (organization_id, membership_period_id) REFERENCES membership_periods(organization_id, id);
ALTER TABLE package_redemptions ADD CONSTRAINT package_redemptions_one_source
  CHECK ((customer_package_id IS NULL) <> (membership_period_id IS NULL));
CREATE INDEX package_redemptions_period_idx ON package_redemptions (membership_period_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['membership_plans','customer_memberships','membership_periods'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON membership_plans TO {{app_role}};
GRANT SELECT, INSERT ON customer_memberships, membership_periods TO {{app_role}};
GRANT UPDATE (ends_on, cancelled_at, cancelled_by_user_id, cancel_reason) ON customer_memberships TO {{app_role}};
