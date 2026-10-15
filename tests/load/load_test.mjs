/**
 * Load check: does the CRM stay fast with a few years of data?
 *
 *   npm run build && node tests/load/load_test.mjs
 *
 * Builds a separate throwaway database (port 54342) with the synthetic staff plus ~20,000
 * inquiries, ~80,000 timeline entries, ~12,000 follow-ups and ~3,000 enrollments with payments,
 * spread over 2 years. Starts the production build against it on port 3001 and times the real API
 * routes as a manager and as a sales agent (each request 7 times). Fails if any median is over 1.5 s.
 * Synthetic data only; the normal local database is not touched.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { startLocalPostgres } from "../../scripts/local-postgres.mjs";

const N = Number(process.env.LOAD_INQUIRIES ?? 20000);
const PORT = 3001;
const SECRET = "load-test-secret-not-real-000000";
const LIMIT_MS = 1500;

const REUSE = process.env.LOAD_DB_URL; // time against an already-built load database (profiling)
let db;
if (REUSE) {
  const pg = (await import("pg")).default;
  const admin = new pg.Client({ connectionString: REUSE });
  await admin.connect();
  db = { url: REUSE, admin, stop: () => admin.end() };
} else {
  console.log(`Building the load database (${N} inquiries)…`);
  db = await startLocalPostgres({ name: "load", port: 54342, database: "crm", seed: true });
}
const q = (s, p) => db.admin.query(s, p);
const t0 = Date.now();
if (!REUSE) await buildData();
async function buildData() {
await q(`
  with staff as (select array_agg(id order by full_name) as ids from public.profiles where role = 'sales'),
       progs as (select array_agg(id order by code) as ids from public.programs where code in ('SAT', 'IELTS')),
       st as (select array_agg(id order by sort) as ids from public.stages),
       mgr as (select id from public.profiles where role = 'manager' limit 1),
       c as (
         insert into public.contacts (name, phone, phone_normalized, created_at)
         select 'Load Contact ' || g, '+2010' || lpad(g::text, 8, '0'), '+2010' || lpad(g::text, 8, '0'), now() - (g % 730) * interval '1 day'
         from generate_series(1, $1) g
         returning id, created_at, (regexp_replace(name, '\\D', '', 'g'))::int as g)
  insert into public.inquiries (contact_id, program_id, stage_id, sales_owner_id, source, created_at, assigned_at, first_contact_attempt_at, last_contact_at, lost_reason, course_id)
  select c.id, progs.ids[1 + c.g % 2], st.ids[1 + (c.g * 7) % 5], staff.ids[1 + c.g % cardinality(staff.ids)], 'manual',
         c.created_at, c.created_at + interval '2 minutes',
         case when c.g % 6 <> 0 then c.created_at + (c.g % 240) * interval '1 minute' end,
         case when c.g % 6 <> 0 then c.created_at + interval '1 day' end,
         null, null
  from c, staff, progs, st`, [N]);
// Lost reasons for the lost stage, and courses on most inquiries.
await q(`update public.inquiries i set lost_reason = (array['Price', 'Chose another provider', 'Not ready', 'No answer'])[1 + abs(hashtext(i.id::text)) % 4]
         where stage_id = (select id from public.stages where system_key = 'lost') and lost_reason is null`);
await q(`update public.inquiries i set course_id = (select c.id from public.courses c where c.program_id = i.program_id order by abs(hashtext(c.id::text || i.id::text)) limit 1)
         where i.course_id is null and abs(hashtext(i.id::text)) % 5 <> 0`);
await q(`insert into public.activities (inquiry_id, type, actor_id, body, created_at)
         select i.id, (array['comment', 'contact_attempt', 'stage_change', 'follow_up_created'])[k], i.sales_owner_id, 'Synthetic history entry ' || k, i.created_at + k * interval '1 hour'
         from public.inquiries i, generate_series(1, 4) k`);
await q(`insert into public.follow_ups (inquiry_id, owner_id, due_at, note, status, created_at)
         select i.id, i.sales_owner_id, now() + ((abs(hashtext(i.id::text)) % 20) - 10) * interval '1 day', 'Synthetic follow-up',
                case when abs(hashtext(i.id::text)) % 3 = 0 then 'open' else 'done' end::public.follow_up_status, i.created_at
         from public.inquiries i where i.sales_owner_id is not null and abs(hashtext(i.id::text)) % 5 < 3`);
// Enrollments, a confirmed cash payment, and an onboarding for ~15% of inquiries.
await q(`with picked as (
           select i.id, i.course_id, i.sales_owner_id, i.created_at from public.inquiries i
           where i.course_id is not null and i.sales_owner_id is not null and i.created_at < now() - interval '4 days' and abs(hashtext(i.id::text || 'e')) % 100 < 15 and not exists (select 1 from public.enrollments e where e.inquiry_id = i.id))
         insert into public.enrollments (inquiry_id, course_id, agreed_total, currency, original_sales_owner_id, created_by, created_at)
         select id, course_id, 9000, 'EGP', sales_owner_id, sales_owner_id, created_at + interval '3 days' from picked`);
await q(`insert into public.payments (enrollment_id, amount, paid_on, method, status, submitted_by, submitted_at, decided_by, decided_at)
         select e.id, 9000, (e.created_at at time zone 'Africa/Cairo')::date, 'cash', 'confirmed', e.created_by, e.created_at,
                (select id from public.profiles where role = 'manager' limit 1), e.created_at + interval '2 hours'
         from public.enrollments e where not exists (select 1 from public.payments p where p.enrollment_id = e.id)`);
await q(`insert into public.onboardings (enrollment_id, support_owner_id, status, created_at, claimed_at)
         select e.id, case when abs(hashtext(e.id::text)) % 4 = 0 then null else (select id from public.profiles where role = 'support' limit 1) end,
                'onboarding', e.created_at + interval '2 hours', e.created_at + interval '3 hours'
         from public.enrollments e where not exists (select 1 from public.onboardings o where o.enrollment_id = e.id)`);
await q("analyze");
}
const counts = (await q(`select (select count(*) from public.inquiries) as inquiries, (select count(*) from public.activities) as activities,
  (select count(*) from public.follow_ups) as follow_ups, (select count(*) from public.enrollments) as enrollments, (select count(*) from public.payments) as payments`)).rows[0];
console.log(`Data ready in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, counts);

if (process.env.LOAD_KEEP) {
  console.log(`Kept running for profiling: ${db.url}`);
  await new Promise(() => {});
}
const people = Object.fromEntries((await q("select full_name, id from public.profiles")).rows.map((r) => [r.full_name, r.id]));
const cookie = (id) => `crm_local_session=${id}.${createHmac("sha256", SECRET).update(id).digest("base64url")}`;

const app = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  env: { ...process.env, DATABASE_URL: db.url, AUTH_MODE: "local", LOCAL_AUTH_SECRET: SECRET, APP_URL: `http://localhost:${PORT}`, GOOGLE_MODE: "off", CRON_SECRET: "load-cron-secret-not-real-000000", NODE_ENV: "production" },
  stdio: "ignore",
  detached: true, // own process group, so the Next.js child server is stopped with it
});
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) break;
  } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 1000));
}

const day = (offset) => new Date(Date.now() + 3 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);
const leads = (filters = {}, sort = { key: "created", dir: "desc" }, search) =>
  `/api/leads?q=${encodeURIComponent(JSON.stringify({ filters, sort, page: 0, pageSize: 50, ...(search ? { search } : {}) }))}`;
const CASES = [
  ["Manager", "Hana Farouk", "Leads, first page of all", leads()],
  ["Manager", "Hana Farouk", "Leads, filtered by stage and course type", leads({ stageKeys: ["contacting", "qualified"] })],
  ["Manager", "Hana Farouk", "Leads, phone search", leads({}, undefined, "0100001234")],
  ["Manager", "Hana Farouk", "Overview", "/api/overview"],
  ["Manager", "Hana Farouk", "Payments queue", "/api/payments?tab=confirmed"],
  ["Manager", "Hana Farouk", "Support customers", "/api/customers"],
  ["Manager", "Hana Farouk", "Reports, last 30 days", `/api/reports?from=${day(-29)}&to=${day(0)}`],
  ["Manager", "Hana Farouk", "Reports, last 12 months", `/api/reports?from=${day(-364)}&to=${day(0)}`],
  ["Manager", "Hana Farouk", "Audit history", "/api/audit"],
  ["Sales", "Nour Hassan", "Leads, own first page", leads()],
  ["Sales", "Nour Hassan", "My Work, overdue", "/api/my-work?bucket=overdue"],
  ["Sales", "Nour Hassan", "Follow-ups", "/api/follow-ups"],
  ["Support", "Laila Ibrahim", "Support My Work", "/api/support-work"],
];

let failed = 0;
console.log(`\n${"Role".padEnd(8)} ${"Screen".padEnd(44)} median    slowest`);
try {
  for (const [role, person, label, path] of CASES) {
    const times = [];
    for (let i = 0; i < 7; i++) {
      const s = performance.now();
      const r = await fetch(`http://localhost:${PORT}${path}`, { headers: { cookie: cookie(people[person]) } });
      await r.text();
      if (!r.ok) throw new Error(`${label}: HTTP ${r.status}`);
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    const med = times[3];
    const ok = med <= LIMIT_MS;
    failed += !ok;
    console.log(`${role.padEnd(8)} ${label.padEnd(44)} ${String(Math.round(med)).padStart(5)} ms ${String(Math.round(times[6])).padStart(6)} ms ${ok ? "" : " ← too slow"}`);
  }
} finally {
  try { process.kill(-app.pid); } catch { app.kill(); }
  await db.stop();
}
console.log(failed ? `\n${failed} screen(s) slower than ${LIMIT_MS} ms` : `\nAll screens under ${LIMIT_MS} ms (median of 7)`);
process.exit(failed ? 1 : 0);
