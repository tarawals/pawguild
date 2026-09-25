# Development status

_Last updated: 2026-09-25 (session 1: foundation)_

## Built and tested

| Area | Data model | API | Authz | UI | Tests |
|---|---|---|---|---|---|
| Organizations, locations, hours, closures | ✅ | — | — | — | — |
| Staff users, memberships (roles), sessions | ✅ | login, logout, me | ✅ | sign-in | integration + e2e |
| Role-based permissions (10 roles) | shared map | enforced per route | ✅ | controls hidden | unit + integration |
| Customers (CRUD, search, archive/restore) | ✅ | ✅ | ✅ | list, detail, form | integration + e2e + component |
| Pets (CRUD, archive/restore) | ✅ | ✅ | ✅ | list, detail, form | integration + e2e |
| Vaccinations (record, void) | ✅ | ✅ | ✅ | on pet page | integration + e2e |
| Audit log (append-only, field diffs) | ✅ | read endpoint | `audit:read` | history panels | integration |
| Dashboard | — | summary | signed-in | counts + vaccine alerts | e2e |
| Tenant isolation (RLS, composite FKs, least privilege) | ✅ | ✅ | — | — | integration |
| Domain logic: money, reservation state machine | shared | — | — | — | unit |

Latest check results: typecheck ✅, 12 shared unit tests ✅, 21 API integration tests ✅,
4 web tests ✅, 2 Playwright e2e tests ✅, production web build ✅.

## Not built yet (in scope, by priority)

1. **Services and pricing**: configurable services (daycare, boarding, grooming, add-ons) with prices in cents
2. **Reservations**: multi-pet reservations, location, service, dates, explicit status
   transitions (state machine already in `packages/shared`), cancel and reschedule
3. **Capacity and resources**: kennels, rooms and runs; availability; capacity checks at booking time
4. **Check-in / check-out** workflow with vaccination and requirement verification
5. **Care records**: feeding, medication (strictly auditable), activities, incidents
6. **Grooming** appointments and groomer assignment
7. **Billing**: invoices, line items, tax, discounts, deposits, payments, refunds, credits, balances
8. Employees and locations admin UI and API; staff scheduling
9. Reports, internal notifications, business settings UI
10. Pet photos (file upload validation and storage)

## Known issues / risks

- **No login rate limiting or lockout yet.** Add before any internet-facing deployment.
- Expired sessions are never purged. A cleanup job is needed.
- Users with several organizations always sign in to their oldest membership, and there is no org switcher.
- The dashboard's "expiring within 30 days" check uses the database server's date, not the
  organization's timezone. Revisit when time-zone-sensitive features such as reservations land.
- The `users` table has no RLS (login needs it before a tenant is known). Any future query that
  lists users must join through `memberships`, which does have RLS.
- The permission map is code-defined. Organization-configurable roles are future work.
- There is no production deployment configuration yet (hosting, TLS, backups, logging sink).
- CI isn't configured. The checks are run manually (see DEVELOPMENT.md).

## Next recommended step

**Services + reservations (daycare/boarding), without resources yet:**
a migration for `services`, `reservations` and `reservation_pets` (composite FKs, RLS, status
CHECK), API endpoints that use `assertTransition` for every status change, a reservations list
and a create form reachable from the customer page, plus integration tests including cross-tenant
access. Capacity checks and resource assignment follow in the next step.
