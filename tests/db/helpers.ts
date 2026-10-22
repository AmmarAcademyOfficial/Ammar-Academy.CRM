import pg from "pg";
import { inject } from "vitest";

export type Role = "manager" | "sales" | "support" | "accountant";
export interface TestUser {
  id: string;
  name: string;
  role: Role;
}

let pool: pg.Pool | null = null;
export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: inject("databaseUrl"), max: 8 });
  return pool;
}

export async function closeDb() {
  await pool?.end();
  pool = null;
}

/** Runs SQL as the superuser (setup only). */
export async function admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(sql, params)).rows as T[];
}

let n = 0;
/** Creates a login (auth.users) and a staff profile. */
export async function createUser(role: Role, name = `${role}-${++n}`): Promise<TestUser> {
  const [u] = await admin<{ id: string }>("insert into auth.users (email) values ($1) returning id", [`${name}-${Date.now()}-${n}@example.test`]);
  await admin("insert into public.profiles (id, full_name, email, role, rotation_order) values ($1, $2, $3, $4, $5)", [u.id, name, `${name}@example.test`, role, n]);
  return { id: u.id, name, role };
}

/**
 * Runs `fn` in a transaction as a signed-in user, the same way the app does:
 * SET LOCAL ROLE authenticated + JWT claims, so RLS and auth.uid() apply.
 * Pass null for an anonymous (signed-out) request.
 */
export async function as<T>(user: TestUser | null, fn: (q: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("begin");
    if (user) {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user.id, role: "authenticated" })]);
    } else {
      await client.query("set local role anon");
    }
    const result = await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Expects a promise to fail with a given SQLSTATE (and optionally a message fragment). */
export async function expectError(p: Promise<unknown>, code: string, message?: string | RegExp) {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message: string };
    if (err.code !== code) throw new Error(`Expected SQLSTATE ${code}, got ${err.code}: ${err.message}`);
    if (message && !(typeof message === "string" ? err.message.includes(message) : message.test(err.message))) {
      throw new Error(`Expected message matching ${message}, got: ${err.message}`);
    }
    return err;
  }
  throw new Error(`Expected SQLSTATE ${code}, but the call succeeded`);
}

export async function programId(code: "SAT" | "IELTS"): Promise<string> {
  return (await admin<{ id: string }>("select id from public.programs where code = $1", [code]))[0].id;
}

export async function outcomeId(key: string): Promise<string> {
  return (await admin<{ id: string }>("select id from public.contact_outcomes where system_key = $1", [key]))[0].id;
}

/** A unique synthetic Egyptian mobile number (unique across test files). */
export function newPhone(): string {
  return `+2010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}

/** Reads a field definition as the JSON payload save_field_definition expects. */
export async function fieldPayload(key: string): Promise<Record<string, unknown> & { id: string }> {
  const [f] = await admin<Record<string, unknown> & { id: string }>(
    `select id, label, type, importance, required_from, to_jsonb(program_ids) as program_ids,
            to_jsonb(visible_to) as visible_to, to_jsonb(editable_by) as editable_by
     from public.field_definitions where key = $1`, [key]);
  const options = await admin("select id, label, archived from public.field_options where field_id = $1 order by sort", [f.id]);
  return { ...f, options };
}

/** Creates an inquiry through the real function, as the given user. */
export async function createInquiry(user: TestUser, extra: Record<string, unknown> = {}): Promise<{ inquiry_id: string; queued: boolean; matched_existing: boolean }> {
  const phone = (extra.phone_normalized as string) ?? newPhone();
  const body = { name: "Test Customer", phone, phone_normalized: phone, program_id: await programId("SAT"), contact_type: "student", ...extra };
  return as(user, async (q) => (await q<{ r: { inquiry_id: string; queued: boolean; matched_existing: boolean } }>("select public.create_inquiry($1) as r", [body]))[0].r);
}

export async function inquiryVersion(id: string): Promise<number> {
  return (await admin<{ version: number }>("select version from public.inquiries where id = $1", [id]))[0].version;
}
