# Development status

_Last updated: 2026-10-01 (session 16: recurring reservations)_

## Built and tested

| Area | Data model | API | Authz | UI | Tests |
|---|---|---|---|---|---|
| Organizations | ✅ | — | — | — | — |
| **Locations admin** (add/edit details and time zone; deactivate only with no upcoming stays and never the last one; reactivate) | ✅ | ✅ | `locations:manage` (general manager and above) | Locations page with a location switcher | integration + e2e |
| **Business hours and closures** (weekly hours per location; closure dates with reason; drop-off and pick-up checked at booking and reschedule; manager override, audited; the booking form shows hours and warns early) | ✅ | ✅ | `locations:manage` to set; `reservations:override_hours` to book outside them | Business hours and Closures panels; booking form hint, warning and override | unit + integration + e2e |
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
| **Reports** (sales by service and month with tax, discounts and credit notes; payments, deposits and refunds by method with net collected; customer balances owed, owed back and account credit; occupancy per day/night vs limits per location; date range with presets; CSV download) | — (derived from existing tables) | ✅ | `reports:read` (shift lead and above) | Reports page | integration (reconciled against invoices, payments, dashboard) + e2e + unit (CSV) |
| **Grooming schedule** (assign a groomer when booking, rescheduling or from the schedule, also after check-in; no double-booking a groomer; day view per location by groomer with unassigned appointments first, stations, notes and time booked; "Only my appointments" for groomers) | ✅ | ✅ | `reservations:read` to view; assign with `reservations:write` or `stays:check_in_out` | Grooming page; Groomer on booking form and reservation page | integration (incl. races, tenant isolation) + e2e |
| **Staff scheduling** (shifts per person and location; week grid; add/edit/delete; copy last week keeping local times across DST and reporting skipped shifts; no overlapping shifts for one person; shifts outside business hours allowed but flagged; "Working today" on the dashboard; each groomer's shift and appointments outside it on the grooming schedule) | ✅ | ✅ | everyone signed in views; `schedules:manage` (managers and above) changes | Staff schedule page; dashboard panel; grooming schedule | unit (DST) + integration (incl. races, tenant isolation) + e2e |
| **Business settings** (organization name, email, phone, time zone; confirmation explaining what a time-zone change affects; currency fixed) | ✅ + RLS split | ✅ | view: signed in; edit: `settings:manage` (owner, administrator) | Business settings page | integration (incl. direct RLS check) + e2e |
| **Internal notifications** (overdue medication, pets past pick-up, arrivals needing vaccinations, unconfirmed bookings in the next 48h, grooming without a groomer, serious or follow-up incidents, over capacity, overpaid invoices, open days with nobody scheduled; each shown only to roles that can act; computed live, clears itself) | — (derived) | ✅ | signed in; items filtered by permission | Notifications page; count in the top bar (rechecks every minute and after every change) | integration + e2e |
| **Recurring reservations** (same-day services on chosen weekdays between two dates, up to six months or 100 dates; preview runs the real booking checks per date and lists skipped dates with a short reason; times stay local across DST; "cancel this and following" with one reason) | ✅ | ✅ | `reservations:write` to book and cancel; `reservations:read` to view | "Repeat on a schedule" on the booking form; Repeating booking panel on reservations | unit + integration + e2e |
| **Sign-in throttling** (per email and per network address; same response for unknown emails) | ✅ | ✅ | — | Server message on sign-in page | integration |
| **Session-ended handling** (back to sign-in with notice, then return to the same page; same-site redirects only) | — | — | — | ✅ | e2e |
| Dashboard (outstanding balances and overpaid invoices, medication due/overdue, open incidents, occupancy today/tonight vs limits, today's arrivals/departures with one-click check-in/out, pets checked in, vaccine alerts; org-timezone "today") | — | summary | signed-in | ✅ | integration + e2e |
| Audit log (append-only, field diffs) | ✅ | read endpoint | `audit:read` | history panels (customer, pet, reservation) | integration |
| Tenant isolation (RLS, composite FKs, least privilege) | ✅ | ✅ | — | — | integration |
| Domain logic: money, pricing/billable quantity, reservation state machine | shared | — | — | — | unit |

Latest check results (2026-10-01): typecheck ✅, 50 shared unit tests ✅, 185 API integration tests ✅,
7 web tests ✅, 46 Playwright e2e tests ✅ (two full runs in a row).
Fixed this session: signing out could land on "Your session ended" instead of the sign-in page when a
background request (e.g. the notifications check) was refused mid-sign-out.

## Not built yet (in scope, by priority)

1. Packages and memberships (prepaid daycare days)
2. More reports (e.g. tax by rate, staff activity), internal notifications, business settings UI
3. Waitlists, pet photos

## Test coverage beyond feature tests

- `auth-hardening.test.ts`: sign-in for every role, identical errors, cookie flags, expiry, revocation, tampering, deactivation, immediate role changes, injection attempts
- `throttle.test.ts`: lockout per email and per address, reset on success, window expiry, no enumeration
- `permissions-matrix.test.ts`: all 10 roles × 61 protected actions against the role map, and no action returns 500
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
  so the sales report shows credit notes as one amount after tax rather than reducing the tax line.
- Reports group by the organization's time zone. A location in a different time zone is still
  grouped by the organization's dates in the sales and payments reports (occupancy uses the
  location's zone). Occupancy compares against today's capacity limits, not the limits in force
  on each past day.
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
- Grooming isn't capacity-limited per location; grooming stations are assigned per pet as resources.
- Any active staff member can be assigned as a groomer (groomers are listed first), since in small
  shops managers often groom too. The grooming schedule shows each groomer's shift and flags
  appointments outside it, but doesn't yet suggest free slots.
- The grooming day and times use the browser's time zone for display, like the rest of the app.
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
- A repeating booking can't be edited as a whole: change single occurrences, or cancel the rest and
  book a new series. Overnight (per-night) services can't repeat. Dates that fail a check are
  skipped, never overridden; book those one at a time with a manager override if needed.
- Notifications have no read or snooze state: an item stays until the problem is resolved. There is
  no email, text or push delivery (in-app only, per current scope).
- Changing the business time zone doesn't move existing bookings (they keep their exact times),
  but it changes which local day they fall on for care, billing and reports.
- Business hours are checked only when a booking is made or its times move. Adding a closure or
  changing hours doesn't change existing bookings; adding a closure reports how many bookings drop
  off or pick up that day so staff can contact those customers.
- Hours are one open–close range per day (no lunch break or split shifts), and there are no
  separate drop-off and pick-up windows.
- Shift times are entered and shown in the browser's time zone, like bookings. Copying a week keeps
  each shift's local time at its location, so a 7 AM shift stays 7 AM across a DST change.
- There's no time-off or availability tracking, and no hours or overtime totals beyond the weekly
  hours shown per person.
- Location access isn't limited by staff location assignments yet: anyone with the permission sees
  and manages every location in the organization.

## Next recommended step

**Packages (prepaid daycare days):** sell a package (e.g. 10 days of daycare for $340) as an
invoice line; the customer's balance of days is used up when daycare is invoiced, instead of
charging the day rate. Needs decisions before building: whether packages expire, whether unused
days can be refunded, and whether a package covers half days. Memberships (recurring monthly fees)
would follow.
