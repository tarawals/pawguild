-- Staff administration: temporary passwords that must be changed at next sign-in.
-- Non-destructive.
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;
GRANT UPDATE (must_change_password, password_changed_at) ON users TO {{app_role}};
