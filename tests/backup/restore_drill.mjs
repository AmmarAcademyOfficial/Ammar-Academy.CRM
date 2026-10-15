/**
 * Backup and restore drill: proves scripts/db-backup.mjs and scripts/db-restore.mjs end to end.
 *
 *  1. Starts a throwaway PostgreSQL server, builds a "live" CRM database (migrations + synthetic data + receipts).
 *  2. Runs the real backup script against it.
 *  3. Restores into a brand-new empty database with the real restore script (which compares row counts).
 *  4. Checks the restored copy still enforces security: row-level security on every table, the same
 *     functions, a sales agent sees only their own leads, reports run for a manager, receipts are intact.
 *
 *   node tests/backup/restore_drill.mjs
 *
 * pg_dump must match the server's major version. EMBEDDED_PG_MODULE can point at another
 * embedded-postgres build (for example version 16 to match a pg_dump 16 on this computer).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { applySql, migrationFiles } from "../../scripts/local-postgres.mjs";
import { seedDev } from "../../scripts/dev-seed.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const { default: EmbeddedPostgres } = await import(process.env.EMBEDDED_PG_MODULE ?? "embedded-postgres");
const WORK = "/tmp/ammar-crm-pg/drill";
const PORT = 54341;
const url = (db) => `postgres://postgres:postgres@localhost:${PORT}/${db}`;
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
spawnSync("chmod", ["-R", "777", "/tmp/ammar-crm-pg"]);
const server = new EmbeddedPostgres({ databaseDir: join(WORK, "data"), user: "postgres", password: "postgres", port: PORT, persistent: false, onLog: () => {} });
await server.initialise();
await server.start();
const receiptsLive = join(WORK, "receipts-live");
const receiptsRestored = join(WORK, "receipts-restored");
process.env.RECEIPTS_DIR = receiptsLive;

try {
  const root = server.getPgClient();
  await root.connect();
  const [{ server_version }] = (await root.query("show server_version")).rows;
  console.log(`Drill server: PostgreSQL ${server_version}`);
  await root.query("create database live");
  await root.query("create database restored");
  await root.end();

  // 1. A live CRM with data.
  const live = new pg.Client({ connectionString: url("live") });
  await live.connect();
  await applySql(live, join(ROOT, "supabase/local/shim.sql"));
  for (const f of migrationFiles()) await applySql(live, f);
  await seedDev(live);
  await live.end();

  // The empty target: only Supabase's auth schema and roles, like a new Supabase project.
  const target = new pg.Client({ connectionString: url("restored") });
  await target.connect();
  await applySql(target, join(ROOT, "supabase/local/shim.sql"));
  await target.end();

  // 2. Backup with the real script.
  const env = { ...process.env, DATABASE_URL: url("live"), AUTH_MODE: "local", STORAGE_MODE: "local", RECEIPTS_DIR: receiptsLive };
  const b = spawnSync("node", ["scripts/db-backup.mjs", "--out", join(WORK, "backups")], { cwd: ROOT, env, encoding: "utf8" });
  console.log(b.stdout.trim());
  check("Backup script finished", b.status === 0, b.stderr.trim().split("\n").slice(-3).join(" "));
  const folder = join(WORK, "backups", readdirSync(join(WORK, "backups"))[0]);
  const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
  check("Backup includes payments, receipts and sign-in accounts",
    manifest.counts["public.payments"] > 0 && manifest.receipts > 0 && manifest.counts["auth.users"] > 0,
    `${manifest.counts["public.payments"]} payments, ${manifest.receipts} receipt files, ${manifest.counts["auth.users"]} accounts`);

  // Refuses to restore over a database that already holds the CRM.
  const guard = spawnSync("node", ["scripts/db-restore.mjs", "--from", folder, "--target", url("live")], { cwd: ROOT, env, encoding: "utf8" });
  check("Restore refuses a database that already has CRM data", guard.status !== 0 && /already has CRM tables/.test(guard.stderr));

  // 3. Restore with the real script (it compares every table's row count with the manifest).
  const r = spawnSync("node", ["scripts/db-restore.mjs", "--from", folder, "--target", url("restored"), "--receipts-dir", receiptsRestored], { cwd: ROOT, env, encoding: "utf8" });
  console.log(r.stdout.trim());
  if (r.status !== 0) console.error(r.stderr.split("\n").filter((l) => !/^\s+at /.test(l)).join("\n"));
  check("Restore script finished and every row count matches", r.status === 0);
  if (r.status !== 0) throw new Error("Restore failed; later checks skipped.");

  // 4. The restored copy is a working, secure CRM.
  const a = new pg.Client({ connectionString: url("live") });
  const z = new pg.Client({ connectionString: url("restored") });
  await a.connect();
  await z.connect();
  const meta = async (c) => ({
    rls: (await c.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity order by 1`)).rows.map((x) => x.relname).join(","),
    tables: Number((await c.query("select count(*) as n from pg_tables where schemaname = 'public'")).rows[0].n),
    functions: Number((await c.query("select count(*) as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')")).rows[0].n),
    policies: Number((await c.query("select count(*) as n from pg_policies where schemaname = 'public'")).rows[0].n),
    grants: (await c.query(`select grantee || '@' || table_name || ':' || string_agg(privilege_type, '/' order by privilege_type) as g from information_schema.role_table_grants
                            where grantee in ('authenticated', 'anon') and table_schema = 'public' group by grantee, table_name order by 1`)).rows.map((x) => x.g).join(","),
    exec: (await c.query(`select p.oid::regprocedure::text || ':' || coalesce(array_to_string(p.proacl, ' '), 'default') as e from pg_proc p
                          join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1`)).rows.map((x) => x.e).join(","),
  });
  const [m1, m2] = [await meta(a), await meta(z)];
  for (const k of Object.keys(m1)) {
    if (m1[k] === m2[k]) continue;
    const x = new Set(String(m1[k]).split(",")), y = new Set(String(m2[k]).split(","));
    console.log(`  differs: ${k}\n    only live: ${[...x].filter((v) => !y.has(v)).slice(0, 6).join(" | ")}\n    only restored: ${[...y].filter((v) => !x.has(v)).slice(0, 6).join(" | ")}`);
  }
  check("Row-level security is on for the same tables", m1.rls === m2.rls && m1.tables === m2.tables, `${m2.tables} tables`);
  check("Same security policies and checked functions", m1.policies === m2.policies && m1.functions === m2.functions, `${m2.policies} policies, ${m2.functions} functions`);
  if (/anon@/.test(m2.grants)) console.log("  anon grants:", m2.grants.split(",").filter((g) => g.startsWith("anon@")).join(" "));
  check("Staff are still read-only (apart from their own saved views and preferences), anonymous visitors have nothing", m1.grants === m2.grants && m2.grants.split(",").every((g) => !/INSERT|UPDATE|DELETE/.test(g) || /@(saved_views|user_preferences):/.test(g)) && !/anon@/.test(m2.grants));
  check("Function permissions are identical (who may run each checked function)", m1.exec === m2.exec);

  const asUser = async (c, email, fn) => {
    const [{ id }] = (await c.query("select id from public.profiles where email = $1", [email])).rows;
    await c.query("begin");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: "authenticated" })]);
      await c.query("set local role authenticated");
      return await fn(id);
    } finally {
      await c.query("rollback");
    }
  };
  const seenByNour = await asUser(z, "nour@example.test", async (id) => {
    const all = Number((await z.query("select count(*) as n from public.inquiries")).rows[0].n);
    const own = Number((await z.query("select count(*) as n from public.inquiries where sales_owner_id = $1", [id])).rows[0].n);
    return { all, own };
  });
  const totalInquiries = manifest.counts["public.inquiries"];
  check("A sales agent still sees only her own leads", seenByNour.all === seenByNour.own && seenByNour.all < totalInquiries, `${seenByNour.all} of ${totalInquiries}`);
  const writeBlocked = await asUser(z, "nour@example.test", async () => {
    try {
      await z.query("update public.inquiries set lost_reason = 'x'");
      return false;
    } catch (e) {
      return e.code === "42501";
    }
  });
  check("Direct table writes are still refused", writeBlocked);
  const day = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const report = await asUser(z, "hana@example.test", async () => (await z.query("select public.report($1) as r", [{ from: day, to: day }])).rows[0].r);
  const reportLive = await asUser(a, "hana@example.test", async () => (await a.query("select public.report($1) as r", [{ from: day, to: day }])).rows[0].r);
  check("Reports give the same figures on the restored copy", JSON.stringify(report.confirmed) === JSON.stringify(reportLive.confirmed) && report.enrollments === reportLive.enrollments,
    `${report.enrollments} enrollments today`);

  const hash = (d, f) => createHash("sha256").update(readFileSync(join(d, f))).digest("hex");
  const files = readdirSync(receiptsLive);
  check("Receipt files restored byte for byte", files.length > 0 && files.every((f) => hash(receiptsLive, f) === hash(receiptsRestored, f)), `${files.length} files`);
  const linked = (await z.query("select receipt_path from public.payments where receipt_path is not null")).rows.map((x) => x.receipt_path.replace("receipts/", ""));
  check("Every restored payment's receipt file exists", linked.every((f) => files.includes(f)), `${linked.length} linked`);
  await a.end();
  await z.end();
} finally {
  await server.stop();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nBackup and restore drill passed");
process.exit(failures ? 1 : 0);
