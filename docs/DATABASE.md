# Database

PostgreSQL 14+. Schema changes are plain SQL files in `apps/api/migrations/`, applied in order by
`apps/api/src/db/migrate.ts` and recorded in `schema_migrations`.

## Migration policy

- Migrations are forward-only. **Never edit an applied migration.** Add a new file instead.
- Every destructive change (drop, narrowing type, data rewrite) must be called out in the file
  header and in `docs/STATUS.md`.
- `{{app_role}}` in a migration is replaced with `APP_DB_ROLE` (default `pawguild_app`).
- Keep `apps/api/src/db/types.ts` in sync with the schema (camelCase names via `CamelCasePlugin`).

## Tenancy rules (apply to every new table)

1. Organization-owned tables have `organization_id uuid NOT NULL`.
2. Add `UNIQUE (organization_id, id)` if other tables will reference it.
3. Reference other tenant tables with composite FKs: `FOREIGN KEY (organization_id, x_id) REFERENCES x(organization_id, id)`.
4. Enable RLS with the standard `tenant` policy (see the DO block in `0001_foundation.sql`).
5. Grant the app role only what it needs. Business records get no DELETE; use `archived_at` or `voided_at`.
6. Add a tenant-isolation test for new endpoints.

## Current schema (0001_foundation)

| Table | Purpose | Notes |
|---|---|---|
| `organizations` | A business (tenant) | timezone, currency |
| `locations` | Physical sites | `daycare_capacity`, `is_active` |
| `location_hours` | Weekly opening hours | one row per weekday; 0 = Sunday |
| `location_closures` | Holidays and closures | one per location per date |
| `users` | Global staff login identity | email unique, lowercase; scrypt hash |
| `memberships` | User ↔ organization with role | role check constraint mirrors `ROLES` |
| `membership_locations` | Which locations an employee works at | |
| `sessions` | Server-side sessions | token stored as SHA-256 hash only |
| `customers` | Pet owners | archived, not deleted; unique active email per org |
| `pets` | Belong to a customer | weight stored as integer grams |
| `pet_vaccinations` | Vaccination records | immutable; mistakes are voided (`voided_at`, `voided_by_user_id`) |
| `audit_log` | Append-only history | `changes` jsonb holds the field diff `{field: {from, to}}` |

Tables without RLS: `users` and `sessions`. They are identity data that login needs before a
tenant is known, and the app only reaches them by id, email or token hash.
`organizations` and `memberships` have RLS that also lets a user see their own memberships.

## Conventions

- Money: `bigint` integer cents (see ADR 0003). Never `numeric` or float in application code.
- Dates without time (birthdays, vaccine expiry): `date`, returned to JS as `YYYY-MM-DD` strings.
- Timestamps: `timestamptz`.
- Status fields: `text` with a `CHECK` constraint listing allowed values, mirrored in `packages/shared`.
- `updated_at` is maintained by the `set_updated_at()` trigger.
