import "server-only";
import { getStaff, type Staff } from "./auth";
import { toResult } from "./result";

const STATUS: Record<string, number> = { forbidden: 403, not_found: 404, conflict: 409, unauthenticated: 401, server: 500 };

/** Wraps a read-only API route: requires an active staff session and returns JSON. */
export async function apiRoute<T>(fn: (staff: Staff) => Promise<T | null>): Promise<Response> {
  const staff = await getStaff();
  if (!staff) return Response.json({ error: "Sign in again." }, { status: 401 });
  try {
    const data = await fn(staff);
    if (data === null) return Response.json({ error: "This record does not exist or is not assigned to you." }, { status: 404 });
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const r = toResult(e);
    if (r.ok) return Response.json({ error: "Error" }, { status: 500 });
    return Response.json({ error: r.error }, { status: STATUS[r.code ?? ""] ?? 400 });
  }
}
