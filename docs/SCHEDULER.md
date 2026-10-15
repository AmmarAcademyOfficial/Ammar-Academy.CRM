# The 2-minute scheduler

Every 2 minutes something must call `POST https://<crm-address>/api/cron/tick` with the header `Authorization: Bearer <CRON_SECRET>`. Each call:

1. syncs every Google Sheet connection (new rows → leads or Needs Review),
2. assigns waiting leads to eligible agents on shift,
3. ends pauses for agents whose shift is over,
4. tells managers if leads are waiting with nobody on shift (at most hourly),
5. about once an hour, deletes receipt uploads that were never attached to a payment and are more than a day old (linked receipts are never touched). To run this housekeeping by hand: `/api/cron/tick?task=cleanup` with the same header.

Calling it more often is safe. Overlapping calls skip instead of piling up, and the row ledger prevents double imports. If calls stop, nothing is lost: the next call catches up.

The route refuses any call without the exact secret (tested). `CRON_SECRET` must be at least 24 characters; generate one with `openssl rand -base64 32`.

## Production: Supabase Cron (needs your approval)

In the Supabase dashboard:

1. **Integrations → Cron:** enable it (the `pg_cron` extension). [Supabase: install Cron](https://supabase.com/docs/guides/cron/install)
2. **Database → Extensions:** enable `pg_net`, so the database can make HTTP calls.
3. In the **SQL Editor**, store the secret in Supabase Vault (never in the job text), then schedule the job:

```sql
-- Once. Use the same value as the app's CRON_SECRET.
select vault.create_secret('<paste CRON_SECRET here>', 'crm_cron_secret');

select cron.schedule(
  'crm-tick-every-2-minutes',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := 'https://<crm-address>/api/cron/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'crm_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
```

This follows Supabase's documented pattern for scheduled HTTP calls with Vault secrets ([Supabase: scheduling functions](https://supabase.com/docs/guides/functions/schedule-functions)), with a Bearer header instead of an API key.

To check it is running: **Integrations → Cron → Jobs → History**, or the "last checked" time on each sheet card in the CRM. To stop it: `select cron.unschedule('crm-tick-every-2-minutes');`

Alternatives, if preferred: any HTTPS cron service, or the hosting provider's cron (Vercel Cron needs a paid plan for per-minute schedules), configured with the same URL and header.

## Local review

```bash
CRON_SECRET=<same as .env.local> npm run scheduler   # calls the local app every 2 minutes
```

Or call it once by hand:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/tick
```

Managers can also press **Sync now** on a sheet, or **Run assignment now** on the Overview.
