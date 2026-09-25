-- Care records: standing pet medications, the care log for stays, and incidents.
-- Non-destructive. Care records are never edited or deleted by the application: mistakes are
-- voided (with who/when/why) and re-entered, so the history stays intact.

-- Care entries must reference a pet that is on the reservation.
ALTER TABLE reservation_pets ADD CONSTRAINT reservation_pets_org_res_pet_key UNIQUE (organization_id, reservation_id, pet_id);

-- ---------------------------------------------------------------------------------------------
-- Standing medication orders for a pet (from the owner/vet). Discontinued, never deleted.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE pet_medications (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL,
  pet_id                     uuid NOT NULL,
  name                       text NOT NULL CHECK (length(trim(name)) > 0),
  dosage                     text NOT NULL CHECK (length(trim(dosage)) > 0),
  instructions               text,
  -- Local times of day the dose is due; empty = as needed only.
  times                      time[] NOT NULL DEFAULT '{}',
  created_by_user_id         uuid NOT NULL REFERENCES users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  discontinued_at            timestamptz,
  discontinued_by_user_id    uuid REFERENCES users(id),
  CHECK ((discontinued_at IS NULL) = (discontinued_by_user_id IS NULL)),
  CHECK (cardinality(times) <= 12),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, pet_id, id),
  FOREIGN KEY (organization_id, pet_id) REFERENCES pets(organization_id, id)
);
CREATE INDEX pet_medications_pet_idx ON pet_medications (organization_id, pet_id) WHERE discontinued_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Care log. One row per thing that happened to a pet during a stay.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE care_logs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  reservation_id       uuid NOT NULL,
  pet_id               uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('feeding','medication','potty','walk','play','rest','grooming','note')),
  occurred_at          timestamptz NOT NULL,
  notes                text,
  -- feeding
  meal                 text CHECK (meal IS NULL OR meal IN ('breakfast','lunch','dinner','snack')),
  amount_eaten         text CHECK (amount_eaten IS NULL OR amount_eaten IN ('all','most','some','none')),
  -- medication (name and dose are snapshotted so later edits to the order can't rewrite history)
  pet_medication_id    uuid,
  medication_name      text,
  dose                 text,
  medication_status    text CHECK (medication_status IS NULL OR medication_status IN ('given','refused','skipped')),
  scheduled_for        timestamptz,
  recorded_by_user_id  uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  voided_at            timestamptz,
  voided_by_user_id    uuid REFERENCES users(id),
  void_reason          text,
  CHECK ((voided_at IS NULL) = (voided_by_user_id IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL)),
  CHECK (kind <> 'feeding' OR (meal IS NOT NULL AND amount_eaten IS NOT NULL)),
  CHECK (kind <> 'medication' OR (medication_name IS NOT NULL AND dose IS NOT NULL AND medication_status IS NOT NULL)),
  CHECK (kind = 'medication' OR (pet_medication_id IS NULL AND medication_name IS NULL AND dose IS NULL
                                 AND medication_status IS NULL AND scheduled_for IS NULL)),
  CHECK (kind = 'feeding' OR (meal IS NULL AND amount_eaten IS NULL)),
  CHECK (scheduled_for IS NULL OR pet_medication_id IS NOT NULL),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, reservation_id, pet_id) REFERENCES reservation_pets(organization_id, reservation_id, pet_id),
  FOREIGN KEY (organization_id, pet_id, pet_medication_id) REFERENCES pet_medications(organization_id, pet_id, id)
);
CREATE INDEX care_logs_reservation_idx ON care_logs (organization_id, reservation_id, occurred_at DESC);
CREATE INDEX care_logs_pet_idx ON care_logs (organization_id, pet_id, occurred_at DESC);
-- A scheduled dose can be recorded once (a voided entry frees the slot to be re-recorded).
CREATE UNIQUE INDEX care_logs_scheduled_dose_key ON care_logs (pet_medication_id, scheduled_for)
  WHERE scheduled_for IS NOT NULL AND voided_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Incidents. The original report is immutable; follow-up and resolution are added later.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE incidents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  pet_id                 uuid NOT NULL,
  reservation_id         uuid,
  occurred_at            timestamptz NOT NULL,
  category               text NOT NULL CHECK (category IN ('injury','illness','behavior','altercation','escape','property','other')),
  severity               text NOT NULL CHECK (severity IN ('low','medium','high')),
  description            text NOT NULL CHECK (length(trim(description)) > 0),
  actions_taken          text,
  owner_notified         boolean NOT NULL DEFAULT false,
  follow_up_required     boolean NOT NULL DEFAULT false,
  follow_up_notes        text,
  reported_by_user_id    uuid NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  resolved_at            timestamptz,
  resolved_by_user_id    uuid REFERENCES users(id),
  resolution             text,
  CHECK ((resolved_at IS NULL) = (resolved_by_user_id IS NULL) AND (resolved_at IS NULL) = (resolution IS NULL)),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, pet_id) REFERENCES pets(organization_id, id),
  FOREIGN KEY (organization_id, reservation_id, pet_id) REFERENCES reservation_pets(organization_id, reservation_id, pet_id)
);
CREATE INDEX incidents_open_idx ON incidents (organization_id, occurred_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX incidents_pet_idx ON incidents (organization_id, pet_id, occurred_at DESC);
CREATE TRIGGER incidents_updated_at BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pet_medications','care_logs','incidents']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I USING (organization_id = current_org_id())
                    WITH CHECK (organization_id = current_org_id())', t);
  END LOOP;
END $$;

-- Least privilege: records can be created and voided/resolved, never rewritten or deleted.
GRANT SELECT, INSERT ON pet_medications, care_logs, incidents TO {{app_role}};
GRANT UPDATE (discontinued_at, discontinued_by_user_id) ON pet_medications TO {{app_role}};
GRANT UPDATE (voided_at, voided_by_user_id, void_reason) ON care_logs TO {{app_role}};
GRANT UPDATE (actions_taken, owner_notified, follow_up_required, follow_up_notes, resolved_at,
              resolved_by_user_id, resolution, updated_at) ON incidents TO {{app_role}};
