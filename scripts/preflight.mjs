/**
 * Go-live check: run with the production settings before the first launch and after every change.
 *
 *   node --env-file=.env.production.local scripts/preflight.mjs
 *
 * Checks the settings (without printing any secret), then connects to the database and checks
 * that every migration is applied, row-level security is on everywhere, staff are read-only,
 * the receipts bucket is private, a manager exists, and the scheduler has run recently.
 * Exits 1 if anything blocks launch.
 */
import pg from "pg";

const e = process.env;
const results = [];
const ok = (name, pass, detail = "", blocking = true) => results.push({ name, pass, detail, blocking });
const isLocal = (u) => /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(u ?? "");

// ── Settings ────────────────────────────────────────────────────────────
ok("DATABASE_URL is set and not a local database", !!e.DATABASE_URL && !isLocal(e.DATABASE_URL));
ok("Real sign-in (AUTH_MODE=supabase)", (e.AUTH_MODE ?? "supabase") === "supabase", `AUTH_MODE=${e.AUTH_MODE ?? "(default supabase)"}`);
ok("Supabase address and publishable key", !!e.NEXT_PUBLIC_SUPABASE_URL?.startsWith("https://") && !!e.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
ok("Supabase secret key present (server only)", !!e.SUPABASE_SECRET_KEY && !e.SUPABASE_SECRET_KEY.includes("replace"));
ok("No secret is exposed to the browser", !Object.keys(e).some((k) => k.startsWith("NEXT_PUBLIC_") && /SECRET|SERVICE|PASSWORD|TOKEN_ENC/i.test(k)));
ok("APP_URL is the https address", !!e.APP_URL?.startsWith("https://"), e.APP_URL ?? "(missing)");
ok("Receipts in private Supabase Storage", (e.STORAGE_MODE ?? ((e.AUTH_MODE ?? "supabase") === "local" ? "local" : "supabase")) === "supabase");
ok("Scheduler secret is long and random", (e.CRON_SECRET ?? "").length >= 32 && !/replace|local|test/i.test(e.CRON_SECRET ?? ""));
const google = e.GOOGLE_MODE ?? "off";
ok("Google Sheets mode is real or off (never simulated)", google !== "fake", `GOOGLE_MODE=${google}`);
if (google === "real") {
  for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_PICKER_API_KEY", "GOOGLE_PROJECT_NUMBER"]) ok(`${k} present`, !!e[k] && !e[k].includes("replace"));
  ok("TOKEN_ENCRYPTION_KEY is 32 bytes", Buffer.from(e.TOKEN_ENCRYPTION_KEY ?? "", "base64").length === 32);
}

// ── Database ────────────────────────────────────────────────────────────
if (e.DATABASE_URL) {
  const c = new pg.Client({ connectionString: e.DATABASE_URL, connectionTimeoutMillis: 10000 });
  try {
    await c.connect();
    const one = async (q) => (await c.query(q)).rows[0];
    ok("Latest migration applied (reports and faster security rules)", (await one("select to_regprocedure('public.report(jsonb)') is not null and to_regprocedure('private.my_inquiry_ids()') is not null as ok")).ok);
    const noRls = (await c.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)).rows.map((r) => r.relname);
    ok("Row-level security on every table", noRls.length === 0, noRls.join(", "));
    const writes = (await c.query(`select distinct table_name from information_schema.role_table_grants
      where grantee in ('authenticated', 'anon') and table_schema = 'public' and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
        and not (grantee = 'authenticated' and table_name in ('saved_views', 'user_preferences'))`)).rows.map((r) => r.table_name);
    ok("Staff and visitors cannot write to tables directly", writes.length === 0, writes.join(", "));
    const bucket = await one("select to_regclass('storage.buckets') is not null as has").then(async (r) => (r.has ? one("select public from storage.buckets where id = 'receipts'") : null));
    ok("Receipts bucket exists and is private", bucket && bucket.public === false, bucket ? "" : "missing");
    const managers = Number((await one("select count(*) as n from public.profiles where role = 'manager' and active")).n);
    ok("At least one active manager", managers > 0, managers ? "" : "run select private.bootstrap_first_manager(...) once in the SQL Editor");
    const tick = await one("select max(last_checked_at) as at from public.sheet_connections");
    ok("Scheduler has run in the last 10 minutes", tick.at && Date.now() - new Date(tick.at).getTime() < 10 * 60_000,
      tick.at ? `last run ${new Date(tick.at).toISOString()}` : "no sheet connected yet (check Integrations → Cron → History)", false);
  } catch (err) {
    ok("Database reachable", false, err.message);
  } finally {
    await c.end().catch(() => {});
  }
}

let blocking = 0;
for (const r of results) {
  const tag = r.pass ? "OK  " : r.blocking ? "FAIL" : "WARN";
  if (!r.pass && r.blocking) blocking++;
  console.log(`${tag} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(blocking ? `\n${blocking} problem(s) block launch.` : "\nReady to launch.");
process.exit(blocking ? 1 : 0);
