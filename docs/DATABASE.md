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
| `locations` | Physical sites | `is_active`; `daycare_capacity` was removed in 0003 (moved to `location_capacities`) |
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

## 0002_services_reservations

| Table | Purpose | Notes |
|---|---|---|
| `services` | Configurable offerings | `category` (daycare/boarding/grooming/training/add_on/other) drives booking behaviour; `price_cents` + `price_unit` (per_day/per_night/per_visit); deactivate with `is_active` |
| `reservations` | A booking for one customer at one location for one service | `status` CHECK + lifecycle timestamps (`confirmed_at`, `checked_in_at`, `checked_out_at`, `cancelled_at` + `cancellation_reason`); **price snapshot** (`unit_price_cents`, `price_unit`) taken at booking |
| `reservation_pets` | Pets on a reservation | carries `customer_id` so composite FKs guarantee every pet belongs to the reservation's customer |

Rules enforced in the API (not yet in the database):
- A pet can't be in two overlapping `pending`/`confirmed`/`checked_in` reservations. Pet rows are
  locked `FOR UPDATE` during the check to serialize concurrent bookings. Intervals are half-open,
  so back-to-back bookings are allowed.
- Status changes must pass `assertTransition` (see `packages/shared/src/reservation-status.ts`).
- Only `pending`/`confirmed` reservations can be edited. Customer, service and location are
  fixed; to change them, cancel and rebook.

## 0003_capacity_resources

| Table / column | Purpose | Notes |
|---|---|---|
| `location_capacities` | Per-location limits | one row per `(location, category)`, where category is `daycare` (pets per local day) or `boarding` (pets per local night); no row = no limit |
| `resources` | Kennels, suites, rooms, runs, play areas, grooming stations | `capacity` = pets it can hold at once; `UNIQUE (location_id, name)`; deactivate with `is_active` |
| `reservation_pets.resource_id` | The kennel or room a pet is assigned to | composite FK to `resources` |

**Destructive change (documented):** `locations.daycare_capacity` was dropped after its values were copied into `location_capacities`.

Rules enforced in the API:
- Capacity periods match `packages/shared/src/capacity.ts` (`daysCovered`, `nightsCovered`) and the SQL in
  `apps/api/src/lib/capacity.ts`. Only `pending`, `confirmed` and `checked_in` reservations count.
- Booking and rescheduling lock the location row (`FOR UPDATE`), so concurrent bookings can't both
  take the last space. Assignments lock the resource rows the same way.
- Over-capacity bookings need `reservations:override_capacity` (managers and above) and are recorded
  in the audit entry as `capacityOverride`.
- A resource must be at the reservation's location, and overlapping active stays can't hold more pets than its `capacity`.

## 0004_vaccine_requirements

| Table | Purpose | Notes |
|---|---|---|
| `service_vaccine_requirements` | Vaccines required per service and species | `(service_id, species, vaccine)`, with names unique case-insensitively; replaced as a set when a service is edited |

Check-in rule (`packages/shared/src/vaccinations.ts`): each required vaccine must have a non-voided
record whose latest `expires_on` is on or after the stay's last local day. Records expiring
mid-stay count as failing. Names match case-insensitively. Managers can override with a reason
(`stays:override_vaccinations`), recorded as `vaccinationOverride` in the check-in audit entry.

Tables without RLS: `users` and `sessions`. They are identity data that login needs before a
tenant is known, and the app only reaches them by id, email or token hash.
`organizations` and `memberships` have RLS that also lets a user see their own memberships.

## Conventions

- Money: `bigint` integer cents (see ADR 0003). Never `numeric` or float in application code.
- Dates without time (birthdays, vaccine expiry): `date`, returned to JS as `YYYY-MM-DD` strings.
- Timestamps: `timestamptz`.
- Status fields: `text` with a `CHECK` constraint listing allowed values, mirrored in `packages/shared`.
- `updated_at` is maintained by the `set_updated_at()` trigger.
