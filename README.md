# PawGuild

**PawGuild — the operating platform for pet-care businesses.**

PawGuild is a B2B SaaS application for dog daycares, boarding facilities, groomers, pet resorts
and multi-location pet-care operators. It is staff-facing operations software: customers, pets,
reservations, check-in/out, daily care, billing, reporting and administration.

> Governing requirements: [`Master-Instructions.md`](Master-Instructions.md).
> Current progress and next steps: [`docs/STATUS.md`](docs/STATUS.md).

## Repository layout

```
apps/api          Fastify + TypeScript REST API, PostgreSQL via Kysely, SQL migrations
apps/web          React + Vite staff web app
packages/shared   Domain logic shared by API and web (money, permissions, reservation states, validation)
e2e               Playwright end-to-end tests
docs              Architecture, database, development, status and decision records
scripts           Local development helpers
```

## Quick start

Requirements: Node.js 20+, PostgreSQL 14+.

```bash
npm install
sudo -u postgres bash scripts/setup-local-db.sh   # local roles + dev/test/e2e databases
cp .env.example apps/api/.env
npm run db:migrate
npm run db:seed                                   # demo business "Harbor Hounds Pet Resort"
npm run dev:api                                   # http://127.0.0.1:3001
npm run dev:web                                   # http://127.0.0.1:5173
```

Sign in as `owner@harborhounds.example` (or `desk@…`, `care@…`) with the `SEED_PASSWORD` from your `.env`.

## Checks

```bash
npm run typecheck
npm test            # unit + API integration tests (needs PostgreSQL)
npm run test:e2e    # Playwright end-to-end tests
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for details.

## Documentation

| Document | Purpose |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | What is built, known issues, next steps |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System structure, request lifecycle, security model |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema, tenancy rules, migration policy |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup, environment variables, testing |
| [docs/PRODUCT-SCOPE.md](docs/PRODUCT-SCOPE.md) | In-scope and out-of-scope features for the current phase |
| [docs/adr/](docs/adr/) | Architecture decision records |

## Brand note

"PawGuild" is the working commercial name. It has had preliminary web research only, which is
not a trademark clearance, and ownership of the pawguild.com domain is not assumed.
