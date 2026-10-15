# Ammar Academy CRM

Sales, payments and customer-onboarding workspace for Ammar Academy (SAT and IELTS).

> **Current status: Phase 6 — Launch readiness (awaiting review).** Hydration errors fixed and guarded by a console scan; database setup by `supabase db push` tested; GitHub checks, error pages and staff emails ready. All phases are built and tested locally: secure core, Google Sheets with shift-based distribution, courses and payments with support onboarding, database-backed reports, audit history, backups with a verified restore drill, and a deployment guide. Not deployed yet; going live needs your approval of the hosting accounts. See [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript |
| Web app | Next.js 16 (App Router) + React 19 |
| Styling | Tailwind CSS 4, brand tokens in `src/app/globals.css` |
| Receipts | Private files: Supabase Storage bucket `receipts` in production, `.local/receipts` in local review |
| Database | PostgreSQL 17 (Supabase in production), migrations in `supabase/migrations/` |
| Auth | Supabase Auth (email + password, invite-only); local pick-a-person mode for review |
| Security | Row-level security + checked `SECURITY DEFINER` functions; staff have read-only table access |
| Validation | Zod (server actions, API routes) + database checks |
| Lead source | Google Sheets via one-click Google sign-in (`drive.file`) and Google's file picker ([how it works](docs/GOOGLE_SHEETS_CONNECTION.md)) |
| Scheduler | Supabase Cron calling `/api/cron/tick` every 2 minutes ([SCHEDULER.md](docs/SCHEDULER.md)) |
| Tests | Vitest (rules), Vitest + real PostgreSQL (permissions and rules), Playwright (browser) |

## Getting started

Full guide: [`docs/SETUP.md`](docs/SETUP.md). Quick local review with synthetic data:

```bash
npm install
npm run db:local                 # terminal 1: PostgreSQL 17 + synthetic data
cp .env.example .env.local       # defaults already point at the local database
npm run dev                      # terminal 2: http://localhost:3000
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Develop, build for production, serve the build |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (business rules) |
| `npm run test:db` | Database tests: starts a throwaway PostgreSQL, applies migrations, checks permissions and rules as different users |
| `npm run db:local` | Local PostgreSQL with synthetic data and simulated Google sheets (`-- --reset` to restore them) |
| `npm run scheduler` | Local stand-in for the 2-minute scheduler |
| `npm run test:e2e` | Every browser check (journeys, accessibility, console scan), each on fresh data; starts its own database and app |
| `npm run test:a11y` | Accessibility scan (axe-core) of every main screen, against a running app |
| `npm run test:load` | Load check with 20,000 synthetic leads on a separate throwaway database |
| `npm run test:backup` | Backup and restore drill (needs `pg_dump` matching the PostgreSQL version) |
| `npm run db:backup` / `db:restore` | The Academy's own backup and verified restore ([BACKUPS.md](docs/BACKUPS.md)) |
| `npm run preflight` | Go-live check of production settings and database ([DEPLOYMENT.md](docs/DEPLOYMENT.md)) |

Browser tests (Python Playwright: `pip install playwright && python3 -m playwright install chromium`): run `npm run build`, stop any local database or app you have running, then `npm run test:e2e`. It starts a fresh database and the app for each suite, runs the console scan in development mode, then the Phase 2–5 journeys and the accessibility scan on the production build. One suite: `bash scripts/run-browser-suites.sh phase4`.

## Project layout

```
supabase/
  migrations/          Schema, security (RLS), checked functions, reference data
  local/shim.sql       Local stand-in for Supabase's auth schema (tests and review only)
scripts/
  local-postgres.mjs   Embedded PostgreSQL 17 for review and tests (no Docker)
  dev-seed.mjs         Synthetic staff, leads and shifts, created through the real functions
  fake-google.mjs      Simulated Google sheets (English SAT form, Arabic IELTS form)
  dev-scheduler.mjs    Calls /api/cron/tick every 2 minutes locally
  db-backup.mjs        Independent backup (database, sign-in accounts, receipts, manifest)
  db-restore.mjs       Restore into an empty database, verified against the manifest
  preflight.mjs        Go-live check
src/
  app/                 Routes: (auth) sign-in pages, (app) workspace pages, api/ read endpoints
  proxy.ts             Session refresh and sign-in redirect
  server/              Server-only: env check, db (runs queries as the signed-in user),
                       auth, queries, actions (all changes), error mapping
    google/            Google OAuth + Sheets client (real and simulated)
    sheets/            Sync engine (ledger-based import) and connect-wizard analysis
    payment-*.ts       Payments, courses and support actions and queries
    storage.ts         Private receipt storage (content check, signed uploads)
  domain/              Types, rules, permissions, filters, sheet header matching and
                       row parsing (no React, no database)
  components/          UI controls and the app shell
  features/            Screens by area: leads, lead-panel, my-work, follow-ups, manager, support, settings
  lib/                 Client helpers: workspace context, API loading, action runner
tests/
  db/                  Permission and rule tests against real PostgreSQL
  e2e/                 Browser tests per phase (multiple staff, persistence, permissions, mobile)
  a11y/                Accessibility scan
  load/                Load check with 20,000 leads
  backup/              Backup and restore drill
docs/                  Setup, Google Sheets connection, scheduler, progress
```

## Deployment

Not deployed. Supabase and hosting accounts and their costs (about US$45/month) need your approval first; nothing is purchased or published without it. Step-by-step guide, costs, monitoring and go-live checklist: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Backups: [`docs/BACKUPS.md`](docs/BACKUPS.md). Staff guide: [`docs/STAFF_GUIDE.md`](docs/STAFF_GUIDE.md).

## Data and privacy

All names, phone numbers and payments in this repository are fictional. Real Academy data is never used in previews, screenshots or tests. No real credentials are stored in the code; `.env.local` is git-ignored.
