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

## 0005_care_records

| Table | Purpose | Notes |
|---|---|---|
| `pet_medications` | Standing medication orders | `times time[]` holds local times of day (empty means as needed); discontinued, never deleted |
| `care_logs` | Everything recorded during a stay | `kind` is feeding, medication, potty, walk, play, rest, grooming or note; kind-specific columns are enforced by CHECKs; medication name and dose are snapshotted; `scheduled_for` links a dose to its slot and is unique per medication while not voided |
| `incidents` | Injury, illness, behavior and other events | the original description is immutable; follow-up fields can be updated; resolution (managers) locks the record |

- Care entries and incidents reference `reservation_pets (organization_id, reservation_id, pet_id)`, so
  they can only be recorded for a pet that is on that stay.
- The app role may only INSERT these rows and UPDATE the void, discontinue, follow-up and resolution
  columns. Rewriting content or deleting is refused by the database (covered by a test).
- Scheduled doses (`apps/api/src/lib/care.ts`) are computed for the local "today" in the location's
  time zone, limited to the part of the day the pet is in our care. A dose is overdue 30 minutes after its time.

## 0006_billing

| Table / column | Purpose | Notes |
|---|---|---|
| `locations.tax_rate_bps` | Sales tax rate for the location | basis points (825 = 8.25%); defaults to 0 |
| `services.is_taxable` | Whether tax applies to the service | defaults to false; toggled per service |
| `invoice_counters` | Next invoice number per organization | numbers are assigned only when an invoice is issued, so they have no gaps |
| `invoices` | Draft → issued → void | issuing snapshots the tax rate and stores the subtotal, discount, tax and total; one live invoice per reservation |
| `invoice_lines` | Charges | integer cents; `discount_cents` ≤ quantity × price; `taxable` is snapshotted from the service |
| `payments` | Money received against an issued invoice | voided with a reason, never deleted; the invoice must belong to the same customer (composite FK) |

Database triggers (so the rules hold even if application code is wrong):
- `invoice_lines_draft_only`: lines can only be added, changed or removed while the invoice is a draft.
- `invoices_guard`: void is final; issued can't go back to draft; issued amounts, tax rate, customer and
  number can't change; on issue it recomputes the totals from the lines and refuses a mismatch.
- `payments_issued_only`: payments only on issued invoices.

Tax: computed once per invoice on the sum of taxable lines after discounts, rounded half away from zero
(`packages/shared/src/invoice.ts` and the same formula in the trigger).
Balance: issued invoice totals minus non-voided payments (`customerBalance` in `routes/billing.ts`).

## 0007_credits_refunds

| Table | Purpose | Notes |
|---|---|---|
| `invoice_credit_notes` | Reduce what's owed on an issued invoice | total credited ≤ invoice total (trigger); reason required |
| `refunds` | Money back to the customer | from an invoice overpayment (`invoice_id` set, ≤ overpaid, trigger) or from account credit (`invoice_id` null); method `account_credit` moves an overpayment onto credit |
| `account_credits` | Signed ledger of customer credit | `received` (deposit/prepayment, with method, optional `reservation_id`), `from_invoice`, `reversal` (voided credit payment) are positive; `applied` and `refunded` are negative; the balance can never go below zero (constraint trigger with a customer row lock) |
| `payments.method` | now also `account_credit` | a payment made by applying credit; voiding it writes a `reversal` |

- Invoice balance = total − credit notes − (payments − invoice refunds). A negative balance means the
  invoice is overpaid (listed under "Overpaid" and counted on the dashboard).
- All three tables are INSERT-only for the application role. Corrections are new entries.
- Payments on an invoice that has refunds can't be voided (credit notes and refunds are used instead).

## 0008_login_attempts

| Table | Purpose | Notes |
|---|---|---|
| `login_attempts` | Sign-in throttling | email (lowercased), ip, succeeded, attempted_at; no RLS (happens before an organization is known); pruned after one day |

## 0009_staff_admin

`users.must_change_password` (set for new staff and after a reset; cleared when the user sets their
own password) and `users.password_changed_at`.

## 0010_location_admin

Grants `DELETE` on `location_hours` and `location_closures` to the app role. They are configuration,
not business records: saving a week's hours replaces the rows, and a closure added by mistake can be
removed. Every change is written to the audit log with the before and after values.

Rules (enforced in the API, `apps/api/src/lib/hours.ts`, logic in `packages/shared/src/hours.ts`):
- If a location has no `location_hours` rows, there is no hours restriction. Once any rows exist, a
  weekday without a row is closed. Opening and closing times are both allowed.
- Drop-off (`starts_at`) and pick-up (`ends_at`) are checked in the location's time zone (falling
  back to the organization's). A stay may span a closed day.
- A reschedule checks only the end that moved.
- `reservations:override_hours` (managers and above) books anyway; the reasons go into the audit entry.

Tables without RLS: `users`, `sessions` and `login_attempts`. They are identity data that login needs before a
tenant is known, and the app only reaches them by id, email or token hash.
`organizations` and `memberships` have RLS that also lets a user see their own memberships.

## Conventions

- Money: `bigint` integer cents (see ADR 0003). Never `numeric` or float in application code.
- Dates without time (birthdays, vaccine expiry): `date`, returned to JS as `YYYY-MM-DD` strings.
- Timestamps: `timestamptz`.
- Status fields: `text` with a `CHECK` constraint listing allowed values, mirrored in `packages/shared`.
- `updated_at` is maintained by the `set_updated_at()` trigger.
