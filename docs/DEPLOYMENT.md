# Deployment guide (prepared, not yet carried out)

Nothing here has been purchased or published. Every step that creates an account, costs money or puts the CRM online needs your approval first.

## What runs where

| Part | Service | Why |
| --- | --- | --- |
| Web app (Next.js) | **Vercel**, region Frankfurt (`fra1`, set in `vercel.json`) | Built for Next.js; next to the database |
| Database, sign-in, receipt files | **Supabase**, region Frankfurt (`eu-central-1`) | PostgreSQL with row-level security, invite-only email login, private file storage, daily backups |
| 2-minute scheduler | **Supabase Cron** calling `/api/cron/tick` | Already inside Supabase; see [SCHEDULER.md](SCHEDULER.md) |
| Lead sheets | **Google Cloud** project (OAuth + Sheets/Drive/Picker APIs) | One-click sheet connection; see [GOOGLE_SHEETS_CONNECTION.md](GOOGLE_SHEETS_CONNECTION.md) |

## Expected monthly cost (checked 15 Oct 2026; confirm on the pricing pages before buying)

| Item | Price | Notes |
| --- | --- | --- |
| Supabase **Pro** | from **US$25/month** per organization | Includes US$10 compute credit (covers one Micro instance), 8 GB database, 100 GB file storage, **daily backups kept 7 days**. The Free plan pauses a project after a week of inactivity and has no backups, so it is only suitable for testing. |
| Supabase Point-in-Time Recovery (optional) | US$100/month per 7 days of history | Restore to any minute instead of the last daily backup. Not needed at launch. |
| Vercel **Pro** | **US$20 per developer seat per month** (includes US$20 usage credit) | The free Hobby plan does not allow commercial use. One seat is enough; staff using the CRM do not need seats. |
| Google Cloud | No charge expected at this volume | Sheets, Drive and Picker APIs within Google's free quotas. |
| **Total** | **about US$45/month** | Plus a domain name if you want e.g. `crm.ammaracademy.com` (you may already own the main domain). |

Sources: [Supabase pricing](https://supabase.com/pricing), [Vercel pricing summary, May 2026](https://makerkit.dev/blog/tutorials/vercel-cost).

## Step by step (after approval)

### 1. Supabase project
1. Create the project at supabase.com: region **Frankfurt (eu-central-1)**, Pro plan, a strong database password kept in a password manager.
2. **Apply the database with one command** (tested on 15 Oct 2026 with Supabase CLI 2.121: all 10 migrations applied in order and recorded):
   ```bash
   npx supabase@2 login
   npx supabase@2 link --project-ref <project ref from the dashboard URL>
   npx supabase@2 db push
   ```
   It lists the migrations and asks before applying. Later updates use the same `db push`; it applies only new files. (Alternative without the CLI: run each file in `supabase/migrations/` in name order in the SQL Editor.)
3. Then follow [SETUP.md → B](SETUP.md#b-supabase-project-needs-your-approval) steps 3–5: first manager, URL configuration, public sign-ups off.
4. **Emails:** in *Authentication → Emails*, paste `supabase/templates/invite.html` into **Invite user** and `supabase/templates/recovery.html` into **Reset password** (subjects are in `supabase/config.toml`). Set a custom SMTP sender (*Project Settings → Auth → SMTP*), for example the Academy's Google Workspace or a transactional email service; Supabase's built-in sender is only for testing.
5. **Password rules** (*Authentication → Providers → Email*): minimum 10 characters with upper/lower case and digits, "Secure password change" on (the same as `supabase/config.toml`).

### 2. Code repository
Put this project in a **private** GitHub repository owned by the Academy. Never commit `.env*` files (already ignored).

The repository includes automatic checks (`.github/workflows/ci.yml`). On every push GitHub runs:
- lint, type-check, unit tests, the database tests and a production build;
- every browser journey, the accessibility scan, and the console scan in development mode (which catches errors like the hydration error fixed in Phase 6).

A red ❌ on a commit means: do not promote that deployment. (The workflow file is checked for validity, but it can only run once the repository is on GitHub.)

### 3. Vercel project
1. **Add New → Project**, import the repository. Framework: Next.js (detected). Build command and output stay default.
2. **Settings → Environment Variables** (Production), using the values from Supabase and the Google setup:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Supabase **transaction pooler** string (port 6543) |
   | `AUTH_MODE` | `supabase` |
   | `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | from Supabase → API keys |
   | `SUPABASE_SECRET_KEY` | from Supabase → API keys (server only) |
   | `APP_URL` | `https://<crm-address>` |
   | `STORAGE_MODE` | `supabase` |
   | `CRON_SECRET` | `openssl rand -base64 32` |
   | `GOOGLE_MODE` | `real` (after the Google setup), otherwise `off` |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`, `TOKEN_ENCRYPTION_KEY` | from the Google setup |

   The app refuses to start with an unsafe combination (local sign-in, simulated Google or local receipt storage against a real database).
3. Deploy. Add the domain under **Settings → Domains** and update `APP_URL` and Supabase's Site URL to match.
4. **Settings → Git:** production branch `main`. Optionally, under **Settings → Deployment Protection**, require the GitHub checks to pass before a production deployment.

### 4. Scheduler
Schedule the 2-minute job with Supabase Cron as in [SCHEDULER.md](SCHEDULER.md).

### 5. Pre-launch check
On your computer, put the production values in `.env.production.local` (never committed), then:

```bash
node --env-file=.env.production.local scripts/preflight.mjs
```

It checks the settings without printing secrets, then the live database: migrations applied, row-level security on every table, staff read-only, receipts bucket private, a manager exists, scheduler running. It must say **Ready to launch**.

### 6. Smoke test (about 15 minutes, fictional data)
1. `https://<crm-address>/api/health` shows `"status":"ok"`.
2. Sign in as the manager; invite one test sales agent and one test support member (your own spare email addresses).
3. **Settings → Shifts**: give the test agent a shift covering now.
4. Connect a Google test sheet with two fictional rows; within 2 minutes both appear as leads and are assigned to the test agent.
5. As the agent: record a contact attempt, start an enrollment, submit a payment with a test image receipt.
6. As the manager: open the receipt, confirm the payment. As support: **Assign to Me**, tick the checklist.
7. **Reports** shows the test lead and payment. Then mark the test leads Invalid and deactivate the test staff.

### 7. Monitoring
- **Uptime:** point a free uptime monitor (for example UptimeRobot or Better Stack) at `https://<crm-address>/api/health` every 5 minutes, alerting your email/phone. It returns 503 if the database is unreachable.
- **Errors:** Vercel → Project → Logs (search `[crm]`, `[cron]`, `[sheets]`). Supabase → Logs for database and auth.
- **Scheduler:** Supabase → Integrations → Cron → History, and the "last checked" time on each sheet card. Managers get an in-app alert when Google access must be reconnected.
- **Backups:** see [BACKUPS.md](BACKUPS.md) — a monthly restore drill is part of the routine.

### 8. Updating the CRM later
1. Run the tests (`npm run lint && npm run typecheck && npm test && npm run test:db`).
2. Apply any new migration files in Supabase **before** deploying the code that needs them.
3. Push to the main branch; Vercel deploys. If something is wrong, **Vercel → Deployments → Promote** the previous deployment (instant rollback). Migrations are written to be additive, so the previous code keeps working.

## Go-live checklist

- [ ] Supabase Pro and Vercel Pro approved and created (Frankfurt)
- [ ] Code in a private GitHub repository; CI checks green
- [ ] Migrations applied with `supabase db push`; first manager created; public sign-ups off
- [ ] Branded invite and reset emails pasted; custom SMTP sender set; password rules set
- [ ] Environment variables set in Vercel; domain connected; `APP_URL` and Supabase Site URL match
- [ ] Google Cloud project set up, OAuth consent screen published (or test users added)
- [ ] Scheduler job running (Cron history shows success)
- [ ] `scripts/preflight.mjs` says **Ready to launch**
- [ ] Smoke test passed and test data cleaned up
- [ ] Uptime monitor on `/api/health`
- [ ] First independent backup taken and a restore drill done ([BACKUPS.md](BACKUPS.md))
- [ ] Each manager has set a strong password; staff invited
- [ ] Deposit rule per program set in **Settings → Payments and Handover**
