# ADR 0002 — Tenant isolation

Status: accepted (2026-09-25)

## Context

PawGuild is multi-tenant, and one organization must never see or change another's data.
Application-level `WHERE organization_id = ?` filters alone fail as soon as one query forgets them.

## Decision

Use a shared database and shared schema, with an `organization_id` column on every tenant row,
and enforce isolation in several independent layers:

1. **Server-derived tenant context.** `req.auth.orgId` comes only from the session. Request
   bodies can't override it, because zod schemas strip unknown keys like `organizationId`.
2. **PostgreSQL row-level security.** Every tenant table has a policy
   `organization_id = current_org_id()`, where `current_org_id()` reads the transaction-local
   setting `app.current_org_id`. It is set by `withTenant()`. With no setting, no rows are visible.
3. **Non-privileged application role.** The API connects as `pawguild_app`. It is neither table
   owner nor superuser, so RLS always applies.
4. **Composite foreign keys.** `(organization_id, customer_id) → customers(organization_id, id)`
   and similar make a cross-tenant reference a constraint violation even for privileged roles.
5. **Tests.** `tenant-isolation.test.ts` asserts 404s for cross-tenant ids, empty lists, rejected
   cross-tenant inserts, and that the app role can't delete records or modify the audit log.

## Consequences

- All tenant data access must go through `withTenant`. A query outside it returns nothing,
  which fails safe.
- Migrations and seeds run as the owner role, which bypasses RLS. They must set
  `organization_id` explicitly.
- Background jobs will need to call `withTenant` per organization.
