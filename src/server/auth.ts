import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { Role } from "@/domain/types";
import { supabaseForRequest } from "@/lib/supabase/server";
import { asSystem } from "./db";
import { env } from "./env";
import { AuthError } from "./result";

export interface Staff {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  paused: boolean;
}

// ── Local development sign-in (AUTH_MODE=local, localhost database only) ──
export const LOCAL_COOKIE = "crm_local_session";

function sign(value: string): string {
  return createHmac("sha256", env().LOCAL_AUTH_SECRET).update(value).digest("base64url");
}

export function localSessionValue(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

function readLocalSession(raw: string | undefined): string | null {
  if (!raw) return null;
  const [id, sig] = raw.split(".");
  if (!id || !sig) return null;
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
}

/** The verified login id of this request, or null when signed out. */
export const getAuthUserId = cache(async (): Promise<string | null> => {
  // Reading cookies first marks every signed-in page as per-request, so builds never need secrets.
  const jar = await cookies();
  if (env().AUTH_MODE === "local") {
    return readLocalSession(jar.get(LOCAL_COOKIE)?.value);
  }
  const supabase = await supabaseForRequest();
  // getClaims verifies the JWT signature; the cookie alone is never trusted.
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return data.claims.sub;
});

/** The signed-in, active staff member for this request, or null. */
export const getStaff = cache(async (): Promise<Staff | null> => {
  const id = await getAuthUserId();
  if (!id) return null;
  const rows = await asSystem(
    (tx) => tx<{ id: string; full_name: string; email: string; role: Role; paused: boolean }[]>`
      select id, full_name, email, role, paused from public.profiles where id = ${id} and active`,
  );
  const p = rows[0];
  return p ? { id: p.id, fullName: p.full_name, email: p.email, role: p.role, paused: p.paused } : null;
});

/** For pages: send signed-out visitors to the sign-in page. */
export async function requireStaffPage(): Promise<Staff> {
  const staff = await getStaff();
  if (staff) return staff;
  const signedIn = await getAuthUserId();
  redirect(signedIn ? "/login?reason=inactive" : "/login");
}

/** For server actions and API routes: refuse when not signed in as active staff. */
export async function requireStaff(): Promise<Staff> {
  const staff = await getStaff();
  if (!staff) throw new AuthError("Your session has ended. Sign in again.");
  return staff;
}

/** The server's clock for this request (passed to the browser so both render the same times). */
export function requestTime(): number {
  return Date.now();
}
