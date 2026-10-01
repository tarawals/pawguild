-- Recurring reservations: a series records the repeating pattern; each occurrence is an ordinary
-- reservation linked by series_id, so it goes through the same checks, care, billing and reports.
-- Series rows are never edited or deleted (cancelling occurrences is done on the reservations).
CREATE TABLE reservation_series (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  customer_id         uuid NOT NULL,
  location_id         uuid NOT NULL,
  service_id          uuid NOT NULL,
  weekdays            smallint[] NOT NULL CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  start_time          time NOT NULL,
  end_time            time NOT NULL,
  first_date          date NOT NULL,
  last_date           date NOT NULL,
  notes               text,
  created_by_user_id  uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  CHECK (last_date >= first_date AND last_date - first_date <= 183),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services(organization_id, id)
);
ALTER TABLE reservation_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON reservation_series USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());
GRANT SELECT, INSERT ON reservation_series TO {{app_role}};

ALTER TABLE reservations ADD COLUMN series_id uuid;
ALTER TABLE reservations ADD CONSTRAINT reservations_series_fk
  FOREIGN KEY (organization_id, series_id) REFERENCES reservation_series (organization_id, id);
CREATE INDEX reservations_series_idx ON reservations (series_id, starts_at) WHERE series_id IS NOT NULL;
