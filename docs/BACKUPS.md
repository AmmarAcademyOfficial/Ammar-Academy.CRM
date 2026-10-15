# Backups and restore

The CRM is protected two ways once it is live:

1. **Supabase automatic backups** (Pro plan): a daily backup kept for 7 days, restorable from the dashboard (**Database → Backups**). Optional Point-in-Time Recovery restores to any minute.
2. **The Academy's own backup**, made with `scripts/db-backup.mjs` and kept outside Supabase. This protects against losing the Supabase account itself, and gives you a copy you control. Suggested routine: weekly, plus before any big change.

## What the Academy's backup contains

| File | Contents |
| --- | --- |
| `crm.dump` | Every CRM table, row, security rule and checked function (PostgreSQL custom format) |
| `auth-users.dump` | Staff sign-in accounts (passwords stay hashed; nobody can read them) |
| `receipts/` | Every payment receipt file |
| `manifest.json` | Row counts per table and checksums, used to prove a restore is complete |

A backup contains personal data. Store it encrypted (for example an encrypted disk image or a private, access-restricted Google Drive folder) and never in the code repository (`/backups/` is ignored by git).

## Making a backup

Needs the PostgreSQL 17 client tools (`pg_dump`, `pg_restore`). On a Mac: `brew install libpq` then `export PG_BIN=$(brew --prefix libpq)/bin`.

```bash
# The DIRECT or SESSION connection string from Supabase (not the transaction pooler):
export DATABASE_URL='postgres://postgres.<ref>:<password>@<host>:5432/postgres'
export NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SECRET_KEY=sb_secret_...      # to download receipts
npm run db:backup -- --out ~/CRM-backups
```

It prints the folder, the number of tables and rows, and the number of receipt files.

## Restoring

Restore **into a new, empty Supabase project**, never over the live one. The script refuses a database that already contains CRM data or sign-in accounts.

```bash
npm run db:restore -- --from ~/CRM-backups/crm-2026-10-20-09-00-00 --target '<new project direct connection string>'
```

The script:
1. checks the backup's checksums (a damaged backup is refused);
2. restores the sign-in accounts, then the whole CRM in a single transaction (all or nothing);
3. pauses Supabase's automatic table permissions during the restore, so the restored copy keeps exactly the backup's read-only staff permissions (the restore drill caught this — without it, staff would have had write access in the restored copy);
4. compares every table's row count with the backup and reports any difference.

Then upload the backup's `receipts/` folder to the new project's private `receipts` bucket (Supabase → Storage), point the app's environment variables at the new project, and redeploy.

For a restore from Supabase's own daily backup, use the dashboard (**Database → Backups → Restore**); Supabase's guide for moving a backup into another project is [Backup and restore using the CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

## The restore drill (proof that backups work)

`npm run test:backup` builds a throwaway CRM with the synthetic data, backs it up with the real script, restores it into an empty database with the real restore script, then checks:

- every row count matches (35 tables, all rows);
- row-level security is on for the same tables, with the same policies and functions;
- staff are still read-only (apart from their own saved views and preferences), visitors have no access;
- function permissions are identical;
- a sales agent still sees only her own leads, and direct writes are refused;
- reports give the same figures;
- every receipt file is restored byte for byte and every payment's receipt exists;
- the restore refuses to run over a database that already has the CRM.

**Last result (15 Oct 2026): 13/13 checks passed** — on PostgreSQL 16, because this review machine only has version 16 client tools. Production runs PostgreSQL 17 with version 17 tools; the commands are the same, but the drill should be repeated once against the real Supabase project (a monthly drill is a good habit).
