-- Staff scheduling: shifts per staff member and location.
-- Shifts are planning data. A shift entered by mistake can be deleted; every create, change and
-- delete is written to the audit log with the full before/after values.
-- Overlapping shifts for one person are refused in the API under an advisory lock per person.
CREATE TABLE shifts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  location_id         uuid NOT NULL,
  membership_id       uuid NOT NULL,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  note                text,
  created_by_user_id  uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (ends_at - starts_at <= interval '16 hours'),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id)
);
CREATE INDEX shifts_org_time_idx ON shifts (organization_id, starts_at);
CREATE INDEX shifts_member_time_idx ON shifts (membership_id, starts_at);
CREATE TRIGGER shifts_updated_at BEFORE UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON shifts USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON shifts TO {{app_role}};
