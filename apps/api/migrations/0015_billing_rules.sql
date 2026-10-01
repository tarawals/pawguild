-- Billing rules: how stays turn into charges (boarding per night / plus daycare / per 24 hours,
-- the half-day limit, grace period, daytime window, which services price daycare, and a discount
-- for additional pets). One row per organization; no row means the defaults (per night, daytime
-- included), which is how billing worked before this migration.
CREATE TABLE billing_settings (
  organization_id            uuid PRIMARY KEY REFERENCES organizations(id),
  boarding_mode              text NOT NULL DEFAULT 'nights' CHECK (boarding_mode IN ('nights','nights_plus_daycare','per_24_hours')),
  boarding_extra_time        text NOT NULL DEFAULT 'daycare' CHECK (boarding_extra_time IN ('extra_night','daycare')),
  half_day_max_minutes       integer NOT NULL DEFAULT 300 CHECK (half_day_max_minutes BETWEEN 60 AND 720),
  grace_period_minutes       integer NOT NULL DEFAULT 30 CHECK (grace_period_minutes BETWEEN 0 AND 180),
  daytime_start              time NOT NULL DEFAULT '07:00',
  daytime_end                time NOT NULL DEFAULT '19:00',
  daycare_full_service_id    uuid,
  daycare_half_service_id    uuid,
  additional_pet_discount_bps integer NOT NULL DEFAULT 0 CHECK (additional_pet_discount_bps BETWEEN 0 AND 10000),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (daytime_end > daytime_start),
  FOREIGN KEY (organization_id, daycare_full_service_id) REFERENCES services(organization_id, id),
  FOREIGN KEY (organization_id, daycare_half_service_id) REFERENCES services(organization_id, id)
);
CREATE TRIGGER billing_settings_updated_at BEFORE UPDATE ON billing_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE billing_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON billing_settings USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());
GRANT SELECT, INSERT, UPDATE ON billing_settings TO {{app_role}};
