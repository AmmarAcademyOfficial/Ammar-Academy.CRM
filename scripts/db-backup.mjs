/**
 * Independent backup of the CRM, kept by the Academy (in addition to Supabase's automatic backups).
 *
 *   node scripts/db-backup.mjs --out backups/            (uses DATABASE_URL and the receipt settings)
 *
 * Writes backups/crm-<Cairo date and time>/ with:
 *   crm.dump          every CRM table, function, security rule and row (schemas public and private),
 *                     PostgreSQL custom format, restorable with scripts/db-restore.mjs
 *   auth-users.dump   staff sign-in accounts (auth.users rows only; passwords stay hashed)
 *   receipts/         every payment receipt file
 *   manifest.json     row counts and SHA-256 checksums, used to verify a restore
 *
 * Needs pg_dump of the same or newer major version as the server (PostgreSQL 17 for Supabase).
 * Set PG_BIN to the folder holding pg_dump if it is not on the PATH.
 * The backup contains personal data: store it encrypted, never in the code repository.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

function run(tool, args) {
  const r = spawnSync(process.env.PG_BIN ? join(process.env.PG_BIN, tool) : tool, args, { encoding: "utf8" });
  if (r.error) throw new Error(`${tool} could not start (${r.error.message}). Install the PostgreSQL client tools or set PG_BIN.`);
  if (r.status !== 0) throw new Error(`${tool} failed:\n${r.stderr}`);
}

export async function tableCounts(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const tables = (await c.query(`select table_schema || '.' || table_name as t from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema in ('public', 'private') order by 1`)).rows.map((r) => r.t);
    const counts = {};
    for (const t of [...tables, "auth.users"]) {
      const [s, n] = t.split(".");
      counts[t] = Number((await c.query(`select count(*) as n from "${s}"."${n}"`)).rows[0].n);
    }
    return counts;
  } finally {
    await c.end();
  }
}

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

async function copyReceipts(dir) {
  const mode = process.env.STORAGE_MODE ?? (process.env.AUTH_MODE === "local" ? "local" : "supabase");
  if (mode === "local") {
    const src = resolve(process.env.RECEIPTS_DIR ?? ".local/receipts");
    if (!existsSync(src)) return 0;
    let n = 0;
    for (const f of readdirSync(src)) {
      copyFileSync(join(src, f), join(dir, "receipts", f));
      n++;
    }
    return n;
  }
  const { createClient } = await import("@supabase/supabase-js");
  const bucket = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } }).storage.from("receipts");
  let n = 0;
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await bucket.list("", { limit: 1000, offset });
    if (error) throw new Error(`Could not list receipts: ${error.message}`);
    for (const f of data ?? []) {
      const { data: blob, error: e } = await bucket.download(f.name);
      if (e) throw new Error(`Could not download ${f.name}: ${e.message}`);
      writeFileSync(join(dir, "receipts", f.name), Buffer.from(await blob.arrayBuffer()));
      n++;
    }
    if (!data || data.length < 1000) break;
  }
  return n;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : fallback;
  };
  const DB = arg("db", process.env.DATABASE_URL);
  const OUT = resolve(arg("out", "backups"));
  if (!DB) {
    console.error("Set DATABASE_URL (or pass --db). Use the direct or session connection string, not the transaction pooler.");
    process.exit(1);
  }

  const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Africa/Cairo", dateStyle: "short", timeStyle: "medium" }).format(new Date()).replace(/[: ]/g, "-");
  const dir = join(OUT, `crm-${stamp}`);
  mkdirSync(join(dir, "receipts"), { recursive: true });
  const counts = await tableCounts(DB);
  run("pg_dump", ["--format=custom", "--no-owner", "--schema=public", "--schema=private", `--file=${join(dir, "crm.dump")}`, DB]);
  run("pg_dump", ["--format=custom", "--no-owner", "--data-only", "--table=auth.users", `--file=${join(dir, "auth-users.dump")}`, DB]);
  const receipts = await copyReceipts(dir);
  const manifest = {
    createdAt: new Date().toISOString(),
    counts,
    receipts,
    files: Object.fromEntries(["crm.dump", "auth-users.dump"].map((f) => [f, sha(join(dir, f))])),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const rows = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Backup written to ${dir}\n  ${Object.keys(counts).length} tables, ${rows} rows, ${receipts} receipt files`);
}
