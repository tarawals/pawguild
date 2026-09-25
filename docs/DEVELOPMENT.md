# Development

## Prerequisites

- Node.js 20+ (developed on 22) and npm 10+
- PostgreSQL 14+ running locally

## Setup

```bash
npm install
sudo -u postgres bash scripts/setup-local-db.sh
cp .env.example apps/api/.env
npm run db:migrate
npm run db:seed
```

Run `npm run dev:api` and `npm run dev:web` in two terminals, then open http://127.0.0.1:5173.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Browser says it can't connect to `127.0.0.1:5173` | `npm run dev:web` isn't running, or it exited with an error; check that terminal. The dev server binds to `127.0.0.1:5173` exactly. |
| `Port 5173 is already in use` | Another dev server is still running. Close it, or find it with `lsof -i :5173` (macOS/Linux) or `netstat -ano \| findstr 5173` (Windows). |
| Page loads but sign-in says "Can't reach PawGuild" | The API isn't running. Start `npm run dev:api` and check it logs `Server listening at http://127.0.0.1:3001`. |
| `ECONNREFUSED 127.0.0.1:5432` or `password authentication failed` | PostgreSQL isn't running, or the roles and databases weren't created. Re-run step 3 of the setup. |
| `Invalid environment configuration` | `apps/api/.env` is missing. Copy it from `.env.example`. |

## Environment variables (apps/api/.env)

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Connection string for the **application** role. It must not be the table owner or a superuser, or RLS is bypassed. |
| `MIGRATION_DATABASE_URL` | yes | Connection string for the schema owner, used by migrations and seed |
| `APP_DB_ROLE` | no (`pawguild_app`) | Role that migrations grant privileges to |
| `PORT` / `HOST` | no (`3001` / `127.0.0.1`) | API listen address |
| `SESSION_TTL_HOURS` | no (`12`) | Session lifetime |
| `COOKIE_SECURE` | no (`false`) | Set `true` whenever served over HTTPS |
| `NODE_ENV` | no | `development`, `test` or `production`. Seeding refuses to run in production. |
| `SEED_PASSWORD` | seed only | Password for the demo staff users |

Web (`apps/web`): `API_PROXY_TARGET` (dev server proxy target; default `http://127.0.0.1:3001`).

Never commit `.env` files or real credentials. `.gitignore` excludes them.

## Testing

| Command | What it runs |
|---|---|
| `npm test` | All workspace tests: shared unit tests, web component tests (jsdom), API integration tests |
| `npm test -w @pawguild/api` | API + PostgreSQL integration tests. `pawguild_test` is wiped and re-migrated first. |
| `npm run test:e2e` | Playwright against the real API and web dev server on `pawguild_e2e` (wiped, migrated and seeded) |
| `npm run typecheck` | `tsc` for every workspace |

Test database URLs can be overridden with `TEST_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL`,
`E2E_DATABASE_URL` and `E2E_MIGRATION_DATABASE_URL`. The setup scripts refuse to wipe a
database whose name doesn't end in `_test` or `_e2e`.

If Playwright's own browser build is unavailable, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a local
Chromium binary.

### What must be tested

- Business rules (pricing, capacity, state transitions, permissions): unit tests in `packages/shared`.
- Every new endpoint: an integration test covering validation, permission denial and **cross-tenant access**.
- Critical staff workflows: a Playwright test.

## Adding a feature (checklist)

1. Migration (constraints, composite FKs, RLS, grants) and `db/types.ts`
2. Shared zod schema and domain logic, with unit tests
3. API route with `authorize(permission)`, `withTenant`, `recordAudit`, and integration tests
4. Web page using `components/ui.tsx`, with a component or e2e test for the key flow
5. Update `docs/STATUS.md`, plus `docs/DATABASE.md` if the schema changed
