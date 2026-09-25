-- PawGuild foundation schema: tenants, locations, staff identity, customers, pets, audit log.
--
-- Tenant isolation is enforced in three layers (see docs/adr/0002-tenant-isolation.md):
--   1. Every tenant-owned row has organization_id NOT NULL.
--   2. Cross-table references use composite foreign keys (organization_id, id) so a row can
--      never point at another organization's row.
--   3. Row-level security restricts the application role to rows of the organization set in
--      the transaction-local setting app.current_org_id.
-- {{app_role}} is substituted by the migration runner with the application's database role.

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;

CREATE FUNCTION current_app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------------------------
-- Organizations and locations
-- ---------------------------------------------------------------------------------------------
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  email       text,
  phone       text,
  timezone    text NOT NULL DEFAULT 'America/New_York',
  currency    char(3) NOT NULL DEFAULT 'USD',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  name              text NOT NULL CHECK (length(trim(name)) > 0),
  address_line1     text,
  address_line2     text,
  city              text,
  region            text,
  postal_code       text,
  country           char(2),
  phone             text,
  email             text,
  timezone          text,
  daycare_capacity  integer CHECK (daycare_capacity IS NULL OR daycare_capacity >= 0),
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name)
);

CREATE TABLE location_hours (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  location_id      uuid NOT NULL,
  weekday          smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday
  opens_at         time NOT NULL,
  closes_at        time NOT NULL,
  CHECK (opens_at < closes_at),
  UNIQUE (location_id, weekday),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id)
);

CREATE TABLE location_closures (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  location_id      uuid NOT NULL,
  closed_on        date NOT NULL,
  reason           text,
  UNIQUE (location_id, closed_on),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- Staff identity. A user is a global login identity; a membership makes them an employee of an
-- organization with a role. Customers do not log in during the current phase.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1),
  password_hash  text NOT NULL,
  first_name     text NOT NULL,
  last_name      text NOT NULL,
  phone          text,
  is_active      boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE memberships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  role             text NOT NULL CHECK (role IN (
                     'owner','administrator','general_manager','location_manager','manager',
                     'shift_lead','front_desk','groomer','care_attendant','employee')),
  job_title        text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE membership_locations (
  organization_id  uuid NOT NULL,
  membership_id    uuid NOT NULL,
  location_id      uuid NOT NULL,
  PRIMARY KEY (membership_id, location_id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id)
);

-- Server-side sessions. Only a SHA-256 hash of the session token is stored.
CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash       text NOT NULL UNIQUE,
  user_id          uuid NOT NULL REFERENCES users(id),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  FOREIGN KEY (organization_id, user_id) REFERENCES memberships(organization_id, user_id)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------------------------------------------------------------------------------------------
-- Customers and pets. Records are archived (archived_at), never hard-deleted by the app.
-- Customer balances are derived from financial records (future migration), not stored here.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE customers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id),
  first_name               text NOT NULL CHECK (length(trim(first_name)) > 0),
  last_name                text NOT NULL CHECK (length(trim(last_name)) > 0),
  email                    text CHECK (email IS NULL OR email = lower(email)),
  phone                    text,
  alt_phone                text,
  address_line1            text,
  address_line2            text,
  city                     text,
  region                   text,
  postal_code              text,
  country                  char(2),
  emergency_contact_name   text,
  emergency_contact_phone  text,
  notes                    text,
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','banned')),
  email_opt_in             boolean NOT NULL DEFAULT true,
  sms_opt_in               boolean NOT NULL DEFAULT false,
  archived_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE INDEX customers_name_idx ON customers (organization_id, lower(last_name), lower(first_name));
CREATE UNIQUE INDEX customers_email_key ON customers (organization_id, email)
  WHERE email IS NOT NULL AND archived_at IS NULL;

CREATE TABLE pets (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  customer_id               uuid NOT NULL,
  name                      text NOT NULL CHECK (length(trim(name)) > 0),
  species                   text NOT NULL CHECK (species IN ('dog','cat','other')),
  breed                     text,
  sex                       text NOT NULL DEFAULT 'unknown' CHECK (sex IN ('male','female','unknown')),
  is_fixed                  boolean,
  date_of_birth             date,
  date_of_birth_is_estimate boolean NOT NULL DEFAULT false,
  weight_grams              integer CHECK (weight_grams IS NULL OR weight_grams > 0),
  color                     text,
  temperament               text,
  behavior_notes            text,
  medical_notes             text,
  allergies                 text,
  feeding_instructions      text,
  special_instructions      text,
  veterinarian_name         text,
  veterinarian_phone        text,
  status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','deceased')),
  archived_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id)
);
CREATE INDEX pets_customer_idx ON pets (organization_id, customer_id);
CREATE INDEX pets_name_idx ON pets (organization_id, lower(name));

-- Vaccination records are never edited in place; a wrong entry is voided and re-entered.
CREATE TABLE pet_vaccinations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  pet_id               uuid NOT NULL,
  vaccine              text NOT NULL CHECK (length(trim(vaccine)) > 0),
  administered_on      date,
  expires_on           date NOT NULL,
  notes                text,
  recorded_by_user_id  uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  voided_at            timestamptz,
  voided_by_user_id    uuid REFERENCES users(id),
  CHECK (administered_on IS NULL OR administered_on <= expires_on),
  CHECK ((voided_at IS NULL) = (voided_by_user_id IS NULL)),
  FOREIGN KEY (organization_id, pet_id) REFERENCES pets(organization_id, id)
);
CREATE INDEX pet_vaccinations_pet_idx ON pet_vaccinations (organization_id, pet_id);

-- ---------------------------------------------------------------------------------------------
-- Audit log: append-only. The application role may INSERT and SELECT only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE audit_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  user_id          uuid REFERENCES users(id),
  action           text NOT NULL,
  entity_type      text NOT NULL,
  entity_id        uuid,
  changes          jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (organization_id, entity_type, entity_id, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (organization_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER locations_updated_at BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER memberships_updated_at BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER pets_updated_at BEFORE UPDATE ON pets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON organizations
  USING (id = current_org_id()
         OR EXISTS (SELECT 1 FROM memberships m
                    WHERE m.organization_id = organizations.id AND m.user_id = current_app_user_id()));

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON memberships
  USING (organization_id = current_org_id() OR user_id = current_app_user_id())
  WITH CHECK (organization_id = current_org_id());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['locations','location_hours','location_closures','membership_locations',
                           'customers','pets','pet_vaccinations','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (organization_id = current_org_id())
                    WITH CHECK (organization_id = current_org_id())', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Application role privileges (least privilege: no DELETE on business records).
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON organizations TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON locations, location_hours, location_closures, memberships,
  customers, pets TO {{app_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON membership_locations TO {{app_role}};
GRANT SELECT, INSERT, UPDATE (voided_at, voided_by_user_id) ON pet_vaccinations TO {{app_role}};
GRANT SELECT, INSERT ON audit_log TO {{app_role}};
GRANT SELECT, INSERT ON users TO {{app_role}};
GRANT UPDATE (first_name, last_name, phone, is_active, last_login_at, password_hash) ON users TO {{app_role}};
GRANT SELECT, INSERT, UPDATE (revoked_at) ON sessions TO {{app_role}};
