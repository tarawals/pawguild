# ADR 0001 — Technology stack

Status: accepted (2026-09-25)

## Decision

- **TypeScript everywhere**, in an npm workspaces monorepo (`apps/api`, `apps/web`, `packages/shared`).
- **API: Fastify 5.** Well documented, fast, first-class TypeScript, with a small plugin surface.
- **Database: PostgreSQL** with **Kysely** as a type-safe query builder and **plain SQL migrations**.
  - Plain SQL gives full access to the PostgreSQL features we rely on: RLS, composite FKs,
    CHECK constraints and partial unique indexes. ORMs tend to hide these.
  - Kysely compiles to predictable SQL and parameterizes all values, which protects against SQL injection.
- **Validation: zod**, shared between API and web.
- **Web: React + Vite + React Router + TanStack Query**, styled with plain CSS design tokens.
- **Tests: Vitest** (unit, component and API integration against a real database) and **Playwright** (e2e).
- **Auth:** server-side sessions in PostgreSQL with scrypt password hashing from Node's crypto,
  so there are no native dependencies and no third-party identity provider yet.

## Alternatives considered

- Next.js full-stack: rejected for now. A separate API keeps a clean boundary for a future
  mobile staff app or public API.
- Prisma: good developer experience, but RLS and per-transaction settings are awkward, and its
  migrations hide SQL details that matter here.
- A hosted auth provider (Auth0, Clerk): may come later for SSO or MFA. Not needed for the MVP.
