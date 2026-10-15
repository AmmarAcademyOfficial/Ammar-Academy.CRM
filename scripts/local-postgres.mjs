/**
 * Local PostgreSQL 17 for development and tests (no Docker, no Supabase account).
 *
 * Applies supabase/local/shim.sql (a stand-in for Supabase's auth schema and roles),
 * then every file in supabase/migrations in order, then optionally the dev seed.
 * Never used in production: the app refuses local sign-in unless DATABASE_URL
 * points at localhost.
 */
import EmbeddedPostgres from "embedded-postgres";
import { mkdirSync, readdirSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { seedDev } from "./dev-seed.mjs";
import { writeFakeGoogle } from "./fake-google.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
// The embedded server runs as a dedicated OS user, so its data folder must be reachable by it.
const BASE = process.env.LOCAL_PG_DIR ?? "/tmp/ammar-crm-pg";

export function migrationFiles() {
  const dir = join(ROOT, "supabase/migrations");
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => join(dir, f));
}

export async function applySql(client, file) {
  const sql = readFileSync(file, "utf8");
  try {
    await client.query(sql);
  } catch (e) {
    e.message = `${file.replace(ROOT, "")}: ${e.message}`;
    throw e;
  }
}

/**
 * Starts a server and creates a fresh database with all migrations applied.
 * Returns { url, stop, admin } where admin is a superuser pg.Client.
 */
export async function startLocalPostgres({ name = "dev", port = 54329, database = "crm", seed = false, persistent = false, reset = true } = {}) {
  mkdirSync(BASE, { recursive: true });
  chmodSync(BASE, 0o777);
  const dataDir = join(BASE, name);
  if (reset && existsSync(dataDir) && !persistent) rmSync(dataDir, { recursive: true, force: true });
  const server = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "postgres", port, persistent, onLog: () => {} });
  if (!existsSync(join(dataDir, "PG_VERSION"))) await server.initialise();
  await server.start();

  const root = server.getPgClient();
  await root.connect();
  const exists = (await root.query("select 1 from pg_database where datname = $1", [database])).rowCount > 0;
  if (exists && reset) {
    await root.query(`drop database ${database} with (force)`);
  }
  if (!exists || reset) {
    await root.query(`create database ${database}`);
  }
  await root.end();

  const url = `postgres://postgres:postgres@localhost:${port}/${database}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  if (!exists || reset) {
    await applySql(admin, join(ROOT, "supabase/local/shim.sql"));
    for (const f of migrationFiles()) await applySql(admin, f);
    if (seed) await seedDev(admin);
  }
  return {
    url,
    admin,
    stop: async () => {
      await admin.end().catch(() => {});
      await server.stop();
    },
  };
}

// CLI: node scripts/local-postgres.mjs [--keep] [--no-seed]
if (import.meta.url === `file://${process.argv[1]}`) {
  const keep = process.argv.includes("--keep");
  const seed = !process.argv.includes("--no-seed");
  const reset = !keep || process.argv.includes("--reset");
  const db = await startLocalPostgres({ seed, persistent: keep, reset });
  // Simulated Google sheets for GOOGLE_MODE=fake, refreshed with the data so times are recent.
  const fakeFile = process.env.FAKE_GOOGLE_FILE ?? ".local/fake-google.json";
  if (seed && (reset || !existsSync(fakeFile))) writeFakeGoogle(fakeFile);
  console.log(`Local database ready:\n  DATABASE_URL=${db.url}\nPress Ctrl+C to stop.`);
  const stop = async () => {
    await db.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
