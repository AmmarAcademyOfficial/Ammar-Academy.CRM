import { sql } from "@/server/db";

export const dynamic = "force-dynamic";

/**
 * Uptime check for monitoring (no sign-in). Says only whether the app can reach the
 * database; never returns data, versions or configuration.
 */
export async function GET() {
  const started = Date.now();
  try {
    await Promise.race([
      sql()`select 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]);
    return Response.json({ status: "ok", database: "ok", ms: Date.now() - started }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "error", database: "unreachable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
