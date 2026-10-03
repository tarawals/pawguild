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

## 0011_grooming

`reservations.groomer_membership_id`: the staff member grooming a grooming appointment, with a
composite FK to `memberships (organization_id, id)` so it can never point at another tenant's staff.
Indexed by groomer and start time. A groomer can't hold two overlapping active appointments; this is
enforced in the API under a transaction-scoped advisory lock per groomer (as with pets and kennels,
not by a database constraint).

## 0012_shifts

`shifts`: one row per staff member per shift at a location (`starts_at`, `ends_at`, optional
`note`), with composite FKs to `locations` and `memberships` and RLS like every tenant table.
A shift is at most 16 hours (`CHECK`). A person can't have overlapping shifts at any location;
this is enforced in the API under an advisory lock per person. Shifts are planning data, so the
app role may `DELETE` them; every create, change and delete is audited with the full values.
Shifts outside business hours are allowed (opening and closing duties) and flagged in the API
response as `warnings`.

## 0013_business_settings

Splits the `organizations` RLS policy by command. Reads are unchanged: members may see the
organizations they belong to. Updates are limited to the current request's organization
(`id = current_org_id()`), so a person in two organizations can never change the other one from
this session. The app role may update only `name`, `email`, `phone` and `timezone`; `currency` and
`slug` are fixed.

Notifications (`/api/notifications`) add no tables: they're computed from live records on each
request, so they clear as soon as the underlying problem is dealt with.

## 0014_reservation_series

`reservation_series` records a repeating pattern (customer, location, service, `weekdays`
`smallint[]` with 0 = Sunday, `start_time`/`end_time`, `first_date`/`last_date` up to 183 days
apart). Each occurrence is an ordinary `reservations` row with `series_id` (composite FK), created
by the same code as a single booking, so every check, care record, invoice and report treats it
normally. Series rows are insert-only; cancelling "this and following" cancels the occurrences.

## 0015_billing_rules

`billing_settings`: one row per organization with how stays are charged. `boarding_mode` is
`nights` (daytime included; the default, and how billing worked before), `nights_plus_daycare`
(each day's time within `daytime_start`–`daytime_end` is charged as a half or full day of daycare)
or `per_24_hours` (24-hour periods from drop-off; time past the last full period, after
`grace_period_minutes`, is charged per `boarding_extra_time`: another period or daycare).
`half_day_max_minutes` (default 300) plus the grace period is the longest half day.
`daycare_full_service_id`/`daycare_half_service_id` name the services whose prices are used for
daycare days. `additional_pet_discount_bps` discounts boarding and daycare for each pet after the
first. The rules are applied by one shared engine (`packages/shared/src/stay-pricing.ts`) for the
booking estimate, the reservation's estimate and the invoice drafted from it.

## 0016_packages

`package_products` (what's sold: full or half days, number of days, price, `expires_after_days`
or NULL for never), `customer_packages` (a sale, with the terms copied and `expires_on` fixed at
sale, linked to the issued invoice that sold it) and `package_redemptions` (one row per day of
daycare paid by a package, linked to the $0 "prepaid" invoice line, `ON DELETE CASCADE` so
deleting that draft line gives the day back). Remaining days are always computed: days minus
redemptions on invoices that aren't void. Packages are spent soonest-expiring first, only for days
on or before `expires_on`, under an advisory lock per customer. A package sale can't be voided
once any of its days are used.

## 0017_package_toggle

`invoices.use_packages` (default true) and `invoice_lines.stay_line`. An invoice drafted from a
reservation uses the customer's packages automatically; while it's a draft, staff can turn that
off or on (`POST /api/invoices/:id/packages`), which deletes and rebuilds only the stay lines
(redemptions go with the deleted lines) and leaves lines added by hand. Invoices drafted before
this migration have no stay lines marked, so their choice can't be changed.

## 0018_memberships

`membership_plans` (name, full or half days per month, monthly price), `customer_memberships` (a
sign-up with the plan's terms copied; `started_on` is the billing day; cancelling sets `ends_on` to
the last day of the paid month) and `membership_periods` (one per billed month, with its issued
invoice; unique per membership and start date, so billing can be run again safely). Months bill on
the sign-up day, or the last day of shorter months (`packages/shared/src/memberships.ts`), at full
price. `package_redemptions` now records a day against either a package or a membership month
(exactly one). Included days only cover daycare dates inside their month and don't roll over;
membership days are used before packages. A month whose invoice is voided can't be used.

## 0019_redemption_guard

A `BEFORE INSERT` trigger on `package_redemptions` (`package_redemptions_guard()`) checks, as defense
in depth behind the API, that the day comes from the invoice customer's own package or membership
month, that `used_on` is inside the package's expiry or the month's period, and that the invoice
line belongs to the invoice. It runs as the caller, so its lookups are still limited by RLS to the
current organization. Violations raise `P0001`.

## Conventions

- Money: `bigint` integer cents (see ADR 0003). Never `numeric` or float in application code.
- Dates without time (birthdays, vaccine expiry): `date`, returned to JS as `YYYY-MM-DD` strings.
- Timestamps: `timestamptz`.
- Status fields: `text` with a `CHECK` constraint listing allowed values, mirrored in `packages/shared`.
- `updated_at` is maintained by the `set_updated_at()` trigger.
