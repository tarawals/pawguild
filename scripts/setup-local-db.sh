#!/usr/bin/env bash
# Creates local PostgreSQL roles and databases for PawGuild development.
# Run as a user that can administer PostgreSQL, e.g.:  sudo -u postgres bash scripts/setup-local-db.sh
# Development-only credentials; never reuse them anywhere else.
set -euo pipefail

psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pawguild') THEN
    CREATE ROLE pawguild LOGIN PASSWORD 'pawguild' CREATEDB;       -- schema owner (migrations, seed)
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pawguild_app') THEN
    CREATE ROLE pawguild_app LOGIN PASSWORD 'pawguild_app';        -- application (RLS applies)
  END IF;
END $$;
SQL

for db in pawguild_dev pawguild_test pawguild_e2e; do
  if ! psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
    createdb -O pawguild "$db"
    echo "created $db"
  fi
done
