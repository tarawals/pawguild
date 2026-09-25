-- Services (configurable offerings with prices) and reservations (multi-pet bookings).
-- Non-destructive: adds tables, constraints and grants only.

-- ---------------------------------------------------------------------------------------------
-- Services. `category` drives booking behaviour (e.g. boarding is overnight, grooming is a
-- timed visit); names, prices and descriptions are fully configurable per organization.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  name              text NOT NULL CHECK (length(trim(name)) > 0),
  category          text NOT NULL CHECK (category IN ('daycare','boarding','grooming','training','add_on','other')),
  description       text,
  price_cents       bigint NOT NULL CHECK (price_cents >= 0),
  price_unit        text NOT NULL CHECK (price_unit IN ('per_day','per_night','per_visit')),
  duration_minutes  integer CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name)
);
CREATE TRIGGER services_updated_at BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Reservations. Price is snapshotted at booking so later price changes don't rewrite history.
-- Status changes are validated by the shared state machine; lifecycle timestamps record when
-- each transition happened.
-- ---------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX pets_org_customer_id_key ON pets (organization_id, customer_id, id);

CREATE TABLE reservations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  location_id          uuid NOT NULL,
  customer_id          uuid NOT NULL,
  service_id           uuid NOT NULL,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','confirmed','checked_in','completed','cancelled','no_show')),
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL,
  unit_price_cents     bigint NOT NULL CHECK (unit_price_cents >= 0),
  price_unit           text NOT NULL CHECK (price_unit IN ('per_day','per_night','per_visit')),
  notes                text,
  created_by_user_id   uuid NOT NULL REFERENCES users(id),
  confirmed_at         timestamptz,
  checked_in_at        timestamptz,
  checked_out_at       timestamptz,
  cancelled_at         timestamptz,
  cancellation_reason  text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (status <> 'checked_in' OR checked_in_at IS NOT NULL),
  CHECK (status <> 'completed' OR (checked_in_at IS NOT NULL AND checked_out_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, customer_id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services(organization_id, id)
);
CREATE INDEX reservations_starts_idx ON reservations (organization_id, location_id, starts_at);
CREATE INDEX reservations_customer_idx ON reservations (organization_id, customer_id, starts_at DESC);
CREATE INDEX reservations_status_idx ON reservations (organization_id, status);
CREATE TRIGGER reservations_updated_at BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Pets on a reservation. The composite keys guarantee every pet belongs to the reservation's customer.
CREATE TABLE reservation_pets (
  organization_id  uuid NOT NULL,
  reservation_id   uuid NOT NULL,
  customer_id      uuid NOT NULL,
  pet_id           uuid NOT NULL,
  PRIMARY KEY (reservation_id, pet_id),
  FOREIGN KEY (organization_id, reservation_id, customer_id)
    REFERENCES reservations(organization_id, id, customer_id),
  FOREIGN KEY (organization_id, customer_id, pet_id) REFERENCES pets(organization_id, customer_id, id)
);
CREATE INDEX reservation_pets_pet_idx ON reservation_pets (organization_id, pet_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['services','reservations','reservation_pets']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (organization_id = current_org_id())
                    WITH CHECK (organization_id = current_org_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON services, reservations TO {{app_role}};
-- Pets may be added to/removed from a reservation before check-in.
GRANT SELECT, INSERT, DELETE ON reservation_pets TO {{app_role}};
