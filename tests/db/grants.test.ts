/**
 * Catalog-wide guard: staff accounts may only read business tables.
 * Catches a new table that forgot to revoke Supabase's default grants.
 */
import { afterAll, describe, expect, it } from "vitest";
import { admin, closeDb } from "./helpers";

afterAll(closeDb);

// Tables where signed-in staff may write their own rows directly (RLS limits them to their own).
const PERSONAL_WRITES: Record<string, string[]> = {
  saved_views: ["INSERT", "UPDATE", "DELETE"],
  user_preferences: ["INSERT", "UPDATE", "DELETE"],
};

describe("table privileges", () => {
  it("anon has no access to any table", async () => {
    const rows = await admin<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'anon'`);
    expect(rows).toEqual([]);
  });

  it("authenticated can only SELECT, apart from personal tables", async () => {
    const rows = await admin<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'authenticated' and privilege_type <> 'SELECT'`);
    const unexpected = rows.filter((r) => !(PERSONAL_WRITES[r.table_name] ?? []).includes(r.privilege_type));
    expect(unexpected).toEqual([]);
  });

  it("every public table has row-level security on", async () => {
    const rows = await admin<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(rows).toEqual([]);
  });

  it("the Google token column is not readable by staff", async () => {
    const rows = await admin<{ ok: boolean }>("select has_column_privilege('authenticated', 'public.google_accounts', 'refresh_token_enc', 'SELECT') as ok");
    expect(rows[0].ok).toBe(false);
  });
});
