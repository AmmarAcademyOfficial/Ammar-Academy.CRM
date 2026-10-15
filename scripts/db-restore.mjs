/**
 * Restores a backup made by scripts/db-backup.mjs into an EMPTY database, then proves it
 * by comparing every table's row count with the backup's manifest.
 *
 *   node scripts/db-restore.mjs --from backups/crm-2026-10-15-14-00-00 --target <empty database URL>
 *
 * The target must already have Supabase's auth schema and roles (any new Supabase project
 * has them) and no CRM tables. It refuses to run against a database that holds CRM data, so a
 * restore can never overwrite the live CRM by mistake.
 * Receipt files are copied back with --receipts-dir <folder> (local) or, for Supabase, by
 * uploading the backup's receipts/ folder to the target project's private "receipts" bucket.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { tableCounts } from "./db-backup.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const FROM = arg("from");
const TARGET = arg("target");
const RECEIPTS_DIR = arg("receipts-dir");
const BIN = (tool) => (process.env.PG_BIN ? join(process.env.PG_BIN, tool) : tool);
if (!FROM || !TARGET) {
  console.error("Usage: node scripts/db-restore.mjs --from <backup folder> --target <empty database URL> [--receipts-dir <folder>]");
  process.exit(1);
}

const dir = resolve(FROM);
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
for (const [f, hash] of Object.entries(manifest.files)) {
  const actual = createHash("sha256").update(readFileSync(join(dir, f))).digest("hex");
  if (actual !== hash) throw new Error(`${f} does not match its checksum; the backup is damaged.`);
}

const c = new pg.Client({ connectionString: TARGET });
await c.connect();
const [{ has_crm, has_auth }] = (await c.query(`select to_regclass('public.profiles') is not null as has_crm, to_regclass('auth.users') is not null as has_auth`)).rows;
const [{ users }] = has_auth ? (await c.query("select count(*)::int as users from auth.users")).rows : [{ users: 0 }];
await c.end();
if (has_crm) throw new Error("The target already has CRM tables. Restore only into a new, empty database.");
if (!has_auth) throw new Error("The target has no auth schema. Use a new Supabase project (or, locally, apply supabase/local/shim.sql first).");
if (users > 0) throw new Error("The target already has sign-in accounts. Restore only into a new, empty project.");

function run(tool, args) {
  const r = spawnSync(BIN(tool), args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${tool} could not start (${r.error.message}). Install the PostgreSQL client tools or set PG_BIN.`);
  if (r.status !== 0) throw new Error(`${tool} failed:\n${r.stderr}`);
  return r.stdout;
}

// Sign-in accounts first (staff profiles refer to them), then the CRM in one transaction.
run("pg_restore", ["--no-owner", "--data-only", "--single-transaction", "--exit-on-error", `--dbname=${TARGET}`, join(dir, "auth-users.dump")]);
// The "public" schema already exists in every database, so its CREATE SCHEMA entry is skipped.
const list = run("pg_restore", ["--list", join(dir, "crm.dump")])
  .split("\n")
  .filter((l) => !/ SCHEMA - public /.test(l) && !/ COMMENT - SCHEMA public /.test(l))
  .join("\n");
const listFile = join(tmpdir(), `crm-restore-${process.pid}.list`);
writeFileSync(listFile, list);
// Supabase (and the local stand-in) automatically grant ALL on every new table and function in
// "public" to the staff and anonymous roles. A restore re-creates every table, so those automatic
// grants would add write access on top of the backup's read-only grants. They are paused for the
// restore and put back afterwards, so the restored permissions are exactly the backup's.
const ROLES = "anon, authenticated, service_role";
const defaults = async (verb) => {
  const d = new pg.Client({ connectionString: TARGET });
  await d.connect();
  try {
    for (const kind of ["tables", "sequences", "functions"]) {
      await d.query(verb === "revoke"
        ? `alter default privileges in schema public revoke all on ${kind} from ${ROLES}`
        : `alter default privileges in schema public grant all on ${kind} to ${ROLES}`);
    }
  } finally {
    await d.end();
  }
};
await defaults("revoke");
try {
  run("pg_restore", ["--no-owner", "--single-transaction", "--exit-on-error", `--use-list=${listFile}`, `--dbname=${TARGET}`, join(dir, "crm.dump")]);
} finally {
  await defaults("grant");
}

if (RECEIPTS_DIR) {
  mkdirSync(resolve(RECEIPTS_DIR), { recursive: true });
  for (const f of readdirSync(join(dir, "receipts"))) copyFileSync(join(dir, "receipts", f), join(resolve(RECEIPTS_DIR), f));
}

const after = await tableCounts(TARGET);
const diffs = Object.entries(manifest.counts).filter(([t, n]) => after[t] !== n).map(([t, n]) => `${t}: backup ${n}, restored ${after[t] ?? "missing"}`);
if (diffs.length) {
  console.error(`Restore finished but does NOT match the backup:\n  ${diffs.join("\n  ")}`);
  process.exit(2);
}
const rows = Object.values(after).reduce((a, b) => a + b, 0);
console.log(`Restore verified: ${Object.keys(after).length} tables and ${rows} rows match the backup${RECEIPTS_DIR ? `, ${manifest.receipts} receipt files copied` : ""}.`);
