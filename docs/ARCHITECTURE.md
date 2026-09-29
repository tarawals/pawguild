# Architecture

## Overview

```
Browser (apps/web, React)
   │  same-origin fetch, session cookie, X-PawGuild-Request header
   ▼
API (apps/api, Fastify)
   │  authorize(permission) → withTenant(org, user) → Kysely queries
   ▼
PostgreSQL  (row-level security + composite tenant foreign keys)
```

`packages/shared` holds logic both sides need: money helpers, the role→permission map, the
reservation state machine and zod input schemas. The API is the authority; the web app reuses
the same schemas and permissions only for early feedback and hiding controls.

In development Vite proxies `/api` to the API, so the browser sees a single origin. Production
should serve the web build and the API under one origin (for example behind a reverse proxy) so
cookies stay first-party.

## Request lifecycle (API)

1. **CSRF guard** (`onRequest`): non-GET requests must carry `X-PawGuild-Request: 1`. Browsers
   can't send a custom header cross-site without a CORS preflight, and no CORS is enabled.
   Session cookies are also `SameSite=Lax` and `HttpOnly`.
2. **Authentication** (`app.authorize()` preHandler): the `pawguild_session` cookie is hashed
   (SHA-256) and looked up in `sessions`; the user must be active and hold an active membership in
   the session's organization. The result is `req.auth` (`AuthContext`): user, organization,
   role, permissions. **Organization and user ids are never taken from client input.**
3. **Authorization**: `app.authorize("customers:write")` checks the permission from the role map in
   `packages/shared/src/permissions.ts`. Routes check permissions, never role names.
4. **Validation**: request bodies and queries are parsed with zod schemas. Failures return
   `400 { error: { code: "validation_failed", message, fields: [{ path, message }] } }`.
5. **Data access**: all tenant data is read and written inside `withTenant(db, req.auth, trx => …)`,
   which opens a transaction and sets `app.current_org_id` / `app.current_user_id`. PostgreSQL
   RLS policies restrict every tenant table to that organization.
6. **Audit**: mutations call `recordAudit(trx, auth, …)` in the same transaction, with a field-level
   diff for updates.
7. **Errors**: `AppError` carries a staff-safe message. Database constraint errors map to
   409/422 with generic messages. Anything else is logged server-side and returns a generic
   500. Stack traces, SQL and constraint names are never sent to clients.

## Tenant isolation (defence in depth)

See [ADR 0002](adr/0002-tenant-isolation.md). In short:

| Layer | Mechanism |
|---|---|
| Application | Tenant comes only from the server-side session; every query runs in `withTenant` |
| Database RLS | Policies on every tenant table compare `organization_id` to `app.current_org_id` |
| Referential | Composite FKs `(organization_id, x_id)` make cross-tenant references impossible |
| Privileges | The app connects as `pawguild_app` (not owner, not superuser), which has no DELETE on business tables and only INSERT/SELECT on `audit_log` |
| Tests | `apps/api/test/tenant-isolation.test.ts` covers API- and DB-level isolation |

## Authentication

- Passwords are hashed with scrypt (N=2^15, r=8, p=1, 16-byte salt) using Node's built-in crypto.
- Login returns the same error for an unknown email and a wrong password, and runs a dummy hash for unknown emails to keep timing uniform.
- Sessions live server-side (so they can be revoked) and expire after `SESSION_TTL_HOURS`.
- **Sign-in throttling** (`auth/throttle.ts`, table `login_attempts`):
  - 5 failures per email or 50 per network address in 15 minutes returns 429 with `Retry-After`.
  - The check runs before the password is verified, and unknown emails are counted the same way.
  - A successful sign-in resets that email's count.
  - In production, `trustProxy` must be set correctly, or every user appears to share the proxy's address.
- **Staff administration** (`routes/employees.ts`):
  - Staff are created with a temporary password and `must_change_password`. Until it's changed,
    `authorize()` refuses every route except `/api/auth/me`, `/api/auth/change-password` and `/api/auth/logout`.
  - Seniority (`ROLE_RANK`, `canAssignRole`, `canManageStaffMember` in `packages/shared`): staff can only
    manage people junior to them and only assign junior roles. Owners are the exception.
  - Nobody can change their own role or deactivate themselves, and the last owner can't be removed.
  - Deactivation and password resets revoke all of that user's sessions.
- When any request finds the session has ended, the web app sends the user to sign-in with a
  notice and returns them to the same page. Post-sign-in redirects only follow same-site paths.
- Users with memberships in several organizations currently sign in to the oldest active
  membership. An organization switcher is future work.

## Web app

- React Router for routing and TanStack Query for server state. There is no global client store.
- `RequireAuth` loads `/api/auth/me` and provides the user, organization and permissions through context.
- `components/ui.tsx` holds the shared form, table and feedback primitives. Fields wire up `label`, `aria-invalid` and `aria-describedby` for hints and errors.
- Styling is plain CSS with design tokens in `styles.css`, with no CSS framework.
- Destructive actions (archive, void) ask for confirmation, and none of them delete data.
