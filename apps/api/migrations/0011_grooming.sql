-- Grooming schedule: a grooming appointment can be assigned to a staff member (the groomer).
-- Double-booking a groomer is prevented in the API under an advisory lock, like pets.
-- Non-destructive.
ALTER TABLE reservations ADD COLUMN groomer_membership_id uuid;
ALTER TABLE reservations ADD CONSTRAINT reservations_groomer_fk
  FOREIGN KEY (organization_id, groomer_membership_id) REFERENCES memberships (organization_id, id);
CREATE INDEX reservations_groomer_time_idx ON reservations (groomer_membership_id, starts_at)
  WHERE groomer_membership_id IS NOT NULL;
