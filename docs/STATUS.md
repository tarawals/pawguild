# Development status

_Last updated: 2026-09-25 (session 3: capacity and kennels)_

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
| Dashboard (occupancy today/tonight vs limits, today's arrivals/departures with one-click check-in/out, pets checked in, vaccine alerts; org-timezone "today") | — | summary | signed-in | ✅ | integration + e2e |
| Audit log (append-only, field diffs) | ✅ | read endpoint | `audit:read` | history panels (customer, pet, reservation) | integration |
| Tenant isolation (RLS, composite FKs, least privilege) | ✅ | ✅ | — | — | integration |
| Domain logic: money, pricing/billable quantity, reservation state machine | shared | — | — | — | unit |

Latest check results: typecheck ✅, 23 shared unit tests ✅, 40 API integration tests ✅,
4 web tests ✅, 7 Playwright e2e tests ✅.

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
- Capacity and kennel rules are enforced in the API under row locks, not by database constraints.
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

**Guided check-in:** from an arrival, show a short check-in panel that verifies required
vaccinations are current (block or warn per service), confirms or assigns a kennel for boarding,
and surfaces care alerts. Then check-out with a care-log and charges review, which leads into
care records and billing.
