-- Vaccination requirements per service and species, verified at check-in.
-- Non-destructive. No requirements are created for existing data: each business configures its own.
CREATE TABLE service_vaccine_requirements (
  organization_id  uuid NOT NULL,
  service_id       uuid NOT NULL,
  species          text NOT NULL CHECK (species IN ('dog','cat','other')),
  vaccine          text NOT NULL CHECK (length(trim(vaccine)) > 0),
  PRIMARY KEY (service_id, species, vaccine),
  FOREIGN KEY (organization_id, service_id) REFERENCES services(organization_id, id)
);
CREATE UNIQUE INDEX service_vaccine_requirements_name_key
  ON service_vaccine_requirements (service_id, species, lower(vaccine));

-- Vaccination lookups by pet during check-in.
CREATE INDEX pet_vaccinations_current_idx ON pet_vaccinations (organization_id, pet_id, expires_on) WHERE voided_at IS NULL;

ALTER TABLE service_vaccine_requirements ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON service_vaccine_requirements USING (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

-- Requirements are replaced as a set when a service is edited (configuration, audited).
GRANT SELECT, INSERT, DELETE ON service_vaccine_requirements TO {{app_role}};
