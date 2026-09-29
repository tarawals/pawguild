-- Sign-in throttling. Failed attempts are counted per email and per network address over a
-- sliding window; a successful sign-in resets the email's count. Rows are pruned after a day.
-- Not tenant data (sign-in happens before an organization is known), so no RLS.
CREATE TABLE login_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         text NOT NULL,
  ip            text NOT NULL,
  succeeded     boolean NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts (email, attempted_at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, attempted_at DESC) WHERE NOT succeeded;

GRANT SELECT, INSERT, DELETE ON login_attempts TO {{app_role}};
