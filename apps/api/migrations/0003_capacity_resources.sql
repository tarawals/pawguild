-- Capacity limits and physical resources (kennels, suites, runs, grooming stations).
--
-- DESTRUCTIVE CHANGE (documented): locations.daycare_capacity is replaced by
-- location_capacities(category = 'daycare'). Existing values are copied before the column is
-- dropped, so no data is lost. No application code enforced the old column.

-- ---------------------------------------------------------------------------------------------
-- Location capacity limits. Daycare is counted in pets per local day; boarding in pets per local
-- night. A missing row means "no limit".
-- ---------------------------------------------------------------------------------------------
CREATE TABLE location_capacities (
  organization_id  uuid NOT NULL,
  location_id      uuid NOT NULL,
  category         text NOT NULL CHECK (category IN ('daycare','boarding')),
  max_pets         integer NOT NULL CHECK (max_pets >= 0),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, category),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id)
);
CREATE TRIGGER location_capacities_updated_at BEFORE UPDATE ON location_capacities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO location_capacities (organization_id, location_id, category, max_pets)
SELECT organization_id, id, 'daycare', daycare_capacity FROM locations WHERE daycare_capacity IS NOT NULL;
ALTER TABLE locations DROP COLUMN daycare_capacity;

-- ---------------------------------------------------------------------------------------------
-- Resources. `capacity` is how many pets can share it at once (e.g. a family suite holds 3).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE resources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  location_id      uuid NOT NULL,
  name             text NOT NULL CHECK (length(trim(name)) > 0),
  kind             text NOT NULL CHECK (kind IN ('kennel','suite','room','run','play_area','grooming_station','other')),
  capacity         integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 100),
  notes            text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, location_id, id),
  UNIQUE (location_id, name),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id)
);
CREATE TRIGGER resources_updated_at BEFORE UPDATE ON resources FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Each pet on a reservation may be assigned one resource.
ALTER TABLE reservation_pets ADD COLUMN resource_id uuid;
ALTER TABLE reservation_pets ADD FOREIGN KEY (organization_id, resource_id) REFERENCES resources(organization_id, id);
CREATE INDEX reservation_pets_resource_idx ON reservation_pets (organization_id, resource_id) WHERE resource_id IS NOT NULL;

-- Occupancy queries filter by location, status and time.
CREATE INDEX reservations_location_window_idx ON reservations (organization_id, location_id, ends_at, starts_at)
  WHERE status IN ('pending','confirmed','checked_in');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['location_capacities','resources']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (organization_id = current_org_id())
                    WITH CHECK (organization_id = current_org_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON location_capacities TO {{app_role}};
GRANT SELECT, INSERT, UPDATE ON resources TO {{app_role}};
GRANT UPDATE (resource_id) ON reservation_pets TO {{app_role}};
