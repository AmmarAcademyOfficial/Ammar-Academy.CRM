# Setup guide

Two ways to run the CRM:

- **A. On your computer with the built-in test database.** No accounts needed, synthetic data, sign in by picking a staff member. Use this to review.
- **B. With a real Supabase project.** Real email/password logins and persistent data. Needed before real use; requires your approval because it creates an online service.

## A. Local review (no accounts)

Requirements: Node.js 22+, npm 10+.

```bash
npm install
npm run db:local          # terminal 1 — starts PostgreSQL 17 on port 54329 with synthetic data
```

In a second terminal, create `.env.local`:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:54329/crm
AUTH_MODE=local
LOCAL_AUTH_SECRET=any-long-random-text-for-your-computer
APP_URL=http://localhost:3000
GOOGLE_MODE=fake                      # simulated Google with two fictional lead sheets
CRON_SECRET=any-random-text-at-least-24-characters
STORAGE_MODE=local                    # receipts kept privately in .local/receipts
```

Then `npm run dev` and open http://localhost:3000. To see automatic syncing, run `npm run scheduler` in a third terminal (same `CRON_SECRET`); it calls the CRM every 2 minutes like the production scheduler.

The sign-in page lists the synthetic staff:

| Person | Role | Has |
| --- | --- | --- |
| Hana Farouk | Manager | Everything |
| Nour Hassan | Sales | 12 inquiries incl. overdue and today's follow-ups · shifts Sun–Thu 09:00–17:00, SAT + IELTS |
| Youssef Adel | Sales | 6 inquiries · Sun–Thu 16:00–midnight SAT, Fri 12:00–20:00 SAT + IELTS |
| Mariam Samir | Sales | 4 inquiries · Sat–Wed 12:00–20:00 and Fri 14:00–22:00 IELTS · leave next week |
| Laila Ibrahim | Support | One customer in onboarding (Sara Nasser) and one waiting in the queue (Jana Ezzat) |

**Try courses and payments (Phase 4):**
- As Hana, open **Settings → Courses and Prices** to add course types and courses.
- **Payments** has one InstaPay deposit to confirm (Hoda Salem, with a fictional PDF receipt).
- As Nour, open a lead such as Nadine Wahba → **Payments** → **Start enrollment** → **Submit payment**. Then confirm the payment as Hana and take the customer as Laila with **Assign to Me**.
- The local data uses a 30% qualifying deposit for SAT and IELTS as an example.

**Try reports and audit history (Phase 5):** as Hana, open **Reports**: change the dates, program and course type, open **How it is counted** on any card, and **Download CSV**. **Settings → Audit History** lists every sensitive change. The synthetic data is small (25 inquiries over two weeks), so most charts are short; `npm run test:load` shows the CRM with 20,000 leads.

Three new inquiries wait in the unassigned queue until the first scheduler run (or **Run assignment now** on the Overview) gives them to whoever is on shift at that moment.

**Try the Google Sheets flow:** as Hana, open **Settings → Google Sheets Connections → Connect Google Sheet**. A clearly labelled *simulated* Google screen and file picker stand in for Google; pick "SAT Leads — Website Form" or the Arabic "IELTS Leads" sheet. To simulate a new form response, add a row to `.local/fake-google.json` and wait for the next scheduler run (or press **Sync now**).

Open two browsers (for example, one normal and one private window) as different people to see each other's changes and permissions.

`npm run db:local -- --reset` restores the original synthetic data. Local sign-in has no passwords. The app refuses to start in this mode unless the database is on the same computer.

## B. Supabase project (needs your approval)

The free Supabase plan is enough for testing. For real use the Pro plan (about US$25/month) adds daily backups; plan details to be confirmed with you before anything is purchased.

1. Create a project at supabase.com. Region: **Frankfurt (eu-central-1)**, the closest to Cairo.
2. **Apply the database.** In *SQL Editor*, run each file in `supabase/migrations/` in name order. Or, with the Supabase CLI: `supabase link` then `supabase db push`.
3. **Create the first manager.**
   - In *Authentication → Users → Add user*, invite your own email.
   - Then in the SQL Editor run:
     ```sql
     select private.bootstrap_first_manager('you@yourdomain.com', 'Your Name');
     ```
   - This works only once, while no manager exists. Everyone else is invited from **Settings → Users** inside the CRM.
4. **Auth settings** (*Authentication → URL Configuration*):
   - Site URL is your CRM address.
   - Add `https://<crm-address>/auth/confirm` to the redirect URLs.
   - Turn **off** public sign-ups (*Authentication → Providers → Email → Allow new users to sign up*). Only invited staff can get in.
5. **Email templates.** Point the *Invite user* and *Reset password* links at `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite` (and `type=recovery` for resets). For reliable delivery, set a custom SMTP sender under *Project Settings → Auth*; Supabase's built-in sender is rate-limited.
6. **Environment** (from *Project Settings → API* and *Database → Connection string*):
   ```bash
   DATABASE_URL=postgres://...pooler.supabase.com:6543/postgres   # "Transaction" pooler string
   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   SUPABASE_SECRET_KEY=sb_secret_...       # server only; used for invitations and deactivation
   APP_URL=https://<crm-address>
   ```
   Keep these in the hosting provider's secret settings, never in the code or in screenshots.
7. **Scheduler:** schedule the 2-minute call with Supabase Cron as described in [SCHEDULER.md](SCHEDULER.md), and add `CRON_SECRET` to the app's settings.
8. **Receipts:** the migrations create a private Storage bucket named `receipts`. Set `STORAGE_MODE=supabase`. Never make the bucket public; the CRM checks permission on every download.
9. **Google Sheets:** the one-time Google setup in [GOOGLE_SHEETS_CONNECTION.md](GOOGLE_SHEETS_CONNECTION.md), then add the `GOOGLE_*` and `TOKEN_ENCRYPTION_KEY` settings.
10. **Shifts:** as manager, enter each agent's weekly shifts in **Settings → Shifts and Distribution**. Until shifts exist, nobody is eligible and every lead waits in the queue.

### How security works (in short)

- Every request runs in the database **as the signed-in person**. Row-level security decides which rows they can read: a sales agent physically cannot load another agent's leads, even by guessing an ID.
- Staff accounts have **read-only** access to tables. Every change goes through a checked database function. Each function verifies the role, the business rules (such as a Lost reason, required fields, or an edit window), and the record version (so two people editing are detected), and writes the activity and audit history in the same step.
- The secret key is used only on the server, for invitations and for disabling logins. It is never sent to the browser.
- Payment receipts are private files. A download is allowed only to managers and the people working on that customer. Uploads are checked by content and tied to the uploader.
- The Google sign-in is stored encrypted and is unreadable to every staff account. The scheduler route needs its own secret.
- An automated test checks every table: staff accounts can only read, row-level security is on everywhere, and the token column is hidden.
