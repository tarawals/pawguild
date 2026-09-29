# Development status

_Last updated: 2026-09-29 (session 10: staff administration)_

## Built and tested

| Area | Data model | API | Authz | UI | Tests |
|---|---|---|---|---|---|
| Organizations, locations, hours, closures | ✅ | locations: read-only list | — | — | — |
| Staff users, memberships (roles), sessions | ✅ | login, logout, me | ✅ | sign-in | integration + e2e |
| Role-based permissions (10 roles) | shared map | enforced per route | ✅ | controls hidden | unit + integration |
| Customers (CRUD, search, archive/restore) | ✅ | ✅ | ✅ | list, detail, form | integration + e2e + component |
| Pets (CRUD, archive/restore) | ✅ | ✅ | ✅ | list, detail, form | integration + e2e |
| Vaccinations (record, void) | ✅ | ✅ | ✅ | on pet page | integration + e2e |
| **Services** (configurable, priced, deactivatable) | ✅ | ✅ | `services:manage` | Services page | integration |
| **Reservations** (multi-pet, price snapshot, reschedule, status lifecycle, cancel with reason, double-booking prevention) | ✅ | ✅ | `reservations:write`, check-in/out needs `stays:check_in_out` | list, booking form with live estimate, detail with status actions, customer panel | unit + integration + e2e |
| **Capacity limits** (daycare/day, boarding/night per location; manager override, audited) | ✅ | ✅ | `locations:manage` to set; `reservations:override_capacity` to exceed | Kennels & capacity page; override option in booking form | unit + integration + e2e |
| **Kennels & rooms** (resources with pet capacity; per-pet assignment with availability) | ✅ | ✅ | `resources:manage` to set up; assign with `reservations:write` or `stays:check_in_out` | Kennels & capacity page; Kennels panel on reservation | integration + e2e |
| **Check-in verification** (required vaccines per service and species, valid through the stay; manager override with reason, audited; kennel reminder) | ✅ | ✅ | `stays:check_in_out`; `stays:override_vaccinations` to override | Check-in panel on reservation (care alerts → vaccinations → kennels); dashboard flags arrivals needing vaccines; requirements on Services | unit + integration + e2e |
| **Medications** (standing orders with scheduled times or as-needed; discontinue, never delete) | ✅ | ✅ | `pets:write` to manage | Medications panel on pet page | unit + integration + e2e |
| **Care log** (feeding, medication given/refused/skipped, potty, walk, play, rest, notes; void with reason, never edit) | ✅ | ✅ | `care:record` | Today's care page with one-tap logging and doses due; Care log panel on reservation | integration + e2e |
| **Incidents** (report, follow up, manager resolves and locks) | ✅ | ✅ | `incidents:record`; `incidents:resolve` (managers) | Report from Today's care; Incidents page | integration + e2e |
| **Sales tax** (rate per location; on/off per service) | ✅ | ✅ | `locations:manage` (rate); `services:manage` (toggle) | Locations page; Taxed switch on Services | unit + integration + e2e |
| **Invoices** (from a reservation at the booked rate, or manual; service/custom lines; per-line $ or % discounts; issue locks the invoice and assigns a gap-free number; void; print) | ✅ + DB triggers | ✅ | `billing:read/write`; voiding issued invoices is `billing:refund` (managers) | Invoices list, invoice page, Billing panel on reservations and customers | unit + integration + e2e |
| **Payments and balances** (can't exceed the balance; managers void mistakes; customer balance; dashboard outstanding) | ✅ | ✅ | `billing:write`; void `billing:refund` | Record payment on invoice | integration + e2e |
| **Credit notes and refunds** (managers; reason required; refund to card/cash/check/other or to account credit; never more than overpaid) | ✅ + DB triggers | ✅ | `billing:refund` | Credits and refunds panel on invoices; Overpaid filter | unit + integration + e2e |
| **Account credit and deposits** (deposit on a reservation or prepayment; apply to invoices; refund credit; never negative) | ✅ + DB trigger | ✅ | take/apply: `billing:write`; refund: `billing:refund` | Account credit panel on customers; Take deposit on reservations; Apply credit on invoices | integration + e2e |
| **Staff administration** (add staff with a temporary password they must change; edit role, title, phone, locations; deactivate, which signs them out everywhere; reactivate; reset password, which also clears a lockout; seniority rules prevent escalation and self-lockout; change your own password) | ✅ | ✅ | `employees:read` to view; `employees:manage` + seniority to change | Staff page; Change password (sidebar); forced password screen | unit + integration + e2e |
| **Check-out review** (per-pet care summary, doses not recorded today, incidents and whether the owner was told, invoice/payment status with create/pay shortcuts; warnings inform but don't block; dashboard "Check out" opens the review) | — | summary endpoint | `reservations:read`; bill only with `billing:read`; check-out needs `stays:check_in_out` | Check-out / Stay summary panel on reservations | integration + e2e |
| **Sign-in throttling** (per email and per network address; same response for unknown emails) | ✅ | ✅ | — | Server message on sign-in page | integration |
| **Session-ended handling** (back to sign-in with notice, then return to the same page; same-site redirects only) | — | — | — | ✅ | e2e |
| Dashboard (outstanding balances and overpaid invoices, medication due/overdue, open incidents, occupancy today/tonight vs limits, today's arrivals/departures with one-click check-in/out, pets checked in, vaccine alerts; org-timezone "today") | — | summary | signed-in | ✅ | integration + e2e |
| Audit log (append-only, field diffs) | ✅ | read endpoint | `audit:read` | history panels (customer, pet, reservation) | integration |
| Tenant isolation (RLS, composite FKs, least privilege) | ✅ | ✅ | — | — | integration |
| Domain logic: money, pricing/billable quantity, reservation state machine | shared | — | — | — | unit |

Latest check results (2026-09-29): typecheck ✅, 36 shared unit tests ✅, 118 API integration tests ✅,
4 web tests ✅, 27 Playwright e2e tests ✅, including a run between 11pm and midnight in the business's time zone.

## Not built yet (in scope, by priority)

1. **Capacity and resources**: kennels, rooms, runs and grooming stations; availability;
   capacity checks at booking time (location `daycare_capacity` exists but isn't enforced);
   business hours and closure checks at booking
2. **Check-in / check-out workflow**: the status buttons exist, but not the guided flow. Still
   needed: vaccination verification at check-in, resource assignment, and a care and charges
   review at check-out
3. **Care records**: feeding, medication (strictly auditable), activities, incidents
4. **Grooming**: groomer assignment and a timed schedule view (grooming can already be booked as a per-visit service)
5. **Billing**: invoices from reservations, add-ons, tax, discounts, deposits, payments, refunds, credits, balances
6. Employees and locations admin; staff scheduling
7. Reports, internal notifications, business settings UI
8. Recurring reservations, waitlists, pet photos

## Test coverage beyond feature tests

- `auth-hardening.test.ts`: sign-in for every role, identical errors, cookie flags, expiry, revocation, tampering, deactivation, immediate role changes, injection attempts
- `throttle.test.ts`: lockout per email and per address, reset on success, window expiry, no enumeration
- `permissions-matrix.test.ts`: all 10 roles × 37 protected actions against the role map, and no action returns 500
- `money-invariants.test.ts`: 40 randomized billing scenarios × 15 operations that must reconcile after every step, plus simultaneous-request races (payments, credit, refunds, invoice numbers, last capacity space, same pet)
- `edge-cases.test.ts`: empty updates, markup/unicode, oversized input, unknown ids
- Browser: `login.spec.ts` (every role, deep links, sign-out, session ending mid-use, safe redirects) and `full-day.spec.ts` (a full visit across three staff members)

## Known issues / risks

- The double-booking rule is enforced in the API with row locks, not by a database constraint.
  A future migration could add an exclusion constraint (`btree_gist`).
- Capacity and kennel rules are enforced in the API under row locks, not by database constraints.
- Dates and times display in the browser's time zone, while medication times and "today" use the
  business's time zone. These match when staff computers are set to the business's time zone.
  Showing everything in the location's zone is future work.
- Credit notes are a single amount that includes any tax. Tax isn't split out of a credit note,
  so tax reports would need that split later.
- Refunds and credit entries can't be voided (they're append-only). A mistaken refund has to be
  corrected with a new entry, such as taking a payment or credit again.
- A deposit is held as general account credit for the customer. It's linked to its reservation for
  display, but it can be applied to any of that customer's invoices.
- There's one tax rate per location. Multiple tax jurisdictions and tax-exempt customers aren't supported.
- Feeding has no schedule (only instructions and a log), so feeding isn't in a "due" list yet.
- Vaccine names are free text, matched case-insensitively. "Bordetella" and "Kennel cough" won't
  match each other. A managed vaccine list would fix that.
- Upgraded installs have no vaccination requirements until a manager sets them on each service.
- Capacity counts pets, not size. Large and small dogs count the same.
- Grooming isn't capacity-limited per location; use grooming stations as resources for now.
- Kennel availability counts any pet assigned during the requested window. That's conservative
  when two short stays share a kennel back to back within the window.
- The booking form reads date/time inputs in the browser's timezone. Billable nights and days
  use the location's timezone, falling back to the organization's. These match as long as staff
  work in the business's timezone.
- Expired sessions are never purged.
- There is no organization switcher for multi-organization users.
- The `users` table has no RLS. Any future user listing must join through `memberships`.
- The permission map is code-defined.
- There is no production deployment configuration and no CI.

## Next recommended step

**Reports (first set):** a Reports page with:
- revenue (issued invoices less credit notes) by service and by month
- payments and refunds by method
- outstanding and overpaid balances
- occupancy by day

Each report gets a date range and CSV download. All figures come from the existing tables, with no
separate reporting store. Reconciliation tests should check that report totals equal the
underlying invoice and payment totals.
