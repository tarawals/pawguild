# Development status

_Last updated: 2026-09-25 (session 2: services and reservations)_

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
| Dashboard (today's arrivals/departures with one-click check-in/out, pets checked in, vaccine alerts; org-timezone "today") | — | summary | signed-in | ✅ | integration + e2e |
| Audit log (append-only, field diffs) | ✅ | read endpoint | `audit:read` | history panels (customer, pet, reservation) | integration |
| Tenant isolation (RLS, composite FKs, least privilege) | ✅ | ✅ | — | — | integration |
| Domain logic: money, pricing/billable quantity, reservation state machine | shared | — | — | — | unit |

Latest check results: typecheck ✅, 18 shared unit tests ✅, 30 API integration tests ✅,
4 web tests ✅, 4 Playwright e2e tests ✅.

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

## Known issues / risks

- **No login rate limiting or lockout yet.** Add before any internet-facing deployment.
- The double-booking rule is enforced in the API with row locks, not by a database constraint.
  A future migration could add an exclusion constraint (`btree_gist`).
- Capacity isn't enforced yet. Staff can overbook a location.
- The booking form reads date/time inputs in the browser's timezone. Billable nights and days
  use the location's timezone, falling back to the organization's. These match as long as staff
  work in the business's timezone.
- Expired sessions are never purged.
- There is no organization switcher for multi-organization users.
- The `users` table has no RLS. Any future user listing must join through `memberships`.
- The permission map is code-defined.
- There is no production deployment configuration and no CI.

## Next recommended step

**Capacity + resources:** a migration for `resources` (kennel, room, run, grooming station per
location) and `reservation_resources`. Then capacity rules: the daycare headcount per location and
day, and one active stay per boarding resource. Enforce them in the reservation create and
reschedule paths with row locking, as the double-booking check does. Show occupancy on the
dashboard. After that, the guided check-in flow with vaccination verification.
